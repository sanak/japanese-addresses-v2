# DuckDB Tier 3 (read_csv_auto 直読み) PoC 設計

- 作成日: 2026-05-23
- 派生元ブランチ: `sqlite-to-duckdb-benchmark-with-chiban-opt`
- 作業ブランチ (予定): `duckdb-tier3-poc-rsdt`
- 対象モジュール: `src/lib/abr_data/`, `src/processes/03_make_rsdt.ts`

## 1. 背景と目的

`docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-design.md` で導入した SQLite/DuckDB 切替 dispatcher により、現状 03 (rsdt) は SQLite 比で北海道 49% 改善・京都府 26% 改善という伸びを観測している。しかし DuckDB 実装 (`src/lib/abr_data/merge_duckdb.ts`) は SQLite 版の直訳になっており、

- `VARCHAR key + JSON data` の単一行構造
- Appender API による JS → Native の行単位投入
- `json_merge_patch` の SQL 内 JSON 解釈

という、列指向 DB の本来の強みをほぼ使えていない構成にとどまっている。本作業の目的は、**DuckDB の `read_csv_auto` による CSV 並列スキャン + native LEFT JOIN** に置換した時の wall time / peak RSS / 出力同一性を、03 を PoC として再現可能に計測することである。

### 非ゴール

- 02 (machi_aza) / 04 (chiban) の改修 (PoC 検証後に別 PR)
- 既存 `mergeDataLeftJoin` AsyncIterator API および `merge_sqlite.ts` の削除
- 永続 DuckDB ファイル化 (Approach 3 — 将来検討)
- ORDER BY の緩和 (Tier 4 — 将来検討)
- `run:all` フロー / npm script の改廃

## 2. 設計判断の要旨

| 観点 | 採用 | 理由 |
|------|------|------|
| API 形態 | **新 API 追加・既存維持** | `mergeRsdtdspRsdtDataDuckdbCsv(mainHubResults, posHubResults)` を新設。既存 `mergeRsdtdspRsdtData(AsyncIterableIterator,...)` は無変更で残し、A/B 比較を維持 |
| CSV 供給 | **毎回 temp に展開しラン後に削除** | 既存 `mkdtemp` パターンと一貫。永続 CSV キャッシュは PoC スコープ外 |
| PoC ターゲット | **03 (rsdt)** | 既に DuckDB を使用済み (memory=false) で SQLite 比 49% 改善という伸びしろが見えている。1 回の大 merge という構造が `read_csv_auto('temp/*.csv', parallel=true)` の glob 入力にハマる |
| settings フィルタ | **DuckDB SQL の WHERE に push down** | `regexp_matches(l.lg_code, '<pattern>')` を `OR` で連結。並列スキャン中にフィルタ可能 |
| ソート | **ORDER BY 全キー維持** | caller (`03_make_rsdt.ts`) が lg_code + machiaza_id 変化で per-machi-aza flush するため。緩和は等価性検証を難化させるので Tier 4 として温存 |
| 分岐機構 | **caller (`03_make_rsdt.ts`) で env 分岐** | TS オーバーロードは実体が単一関数で可読性低下。新名前 + caller 分岐の方が将来の削除も clean |
| env 名 | **`MERGE_BACKEND=duckdb-csv`** | 既存 `duckdb` / 未設定 `sqlite` と並列。未知値は従来パスにフォールバック (既存 dispatch 思想踏襲) |

## 3. アーキテクチャ

```
┌──────────────────────────────────────────────────────────────────────┐
│                       03_make_rsdt.ts (caller)                       │
│                                                                      │
│  ① loadSettings()  ② Hub item 解決 (main/pos × N pref)                │
│  ③ if (MERGE_BACKEND=duckdb-csv)                                     │
│       → mergeRsdtdspRsdtDataDuckdbCsv(mainResults, posResults)       │
│     else                                                             │
│       → 既存 mergeRsdtdspRsdtData(combineCSVParserIterators...)      │
│  ④ for await (raw of rawData) { per-machi-aza flush, 出力 }          │
└──────────────────────────────────────────────────────────────────────┘
```

```
src/lib/abr_data/
├─ index.ts                    [無変更] 既存 dispatcher
├─ merge_sqlite.ts             [無変更]
├─ merge_duckdb.ts             [無変更]
├─ merge_duckdb_csv.ts         [新規] CSV 直読み JOIN 実装 (PoC 本体)
├─ merge_duckdb_csv.test.ts    [新規] 単体テスト
├─ rsdtdsp_rsdt.ts             [無変更] mergeRsdtdspRsdtData は触らない
└─ ...

src/lib/
├─ zip_tools.ts                [追記]  unzipToFiles ヘルパー追加

src/processes/
└─ 03_make_rsdt.ts             [変更]  Hub 検索結果を保持し、env で分岐
```

### 新 API のシグネチャ

```ts
// src/lib/abr_data/merge_duckdb_csv.ts
export async function* mergeRsdtdspRsdtDataDuckdbCsv(
  mainHubResults: HubSearchResult[],
  posHubResults:  HubSearchResult[],
): AsyncIterableIterator<RsdtdspRsdtDataWithPos>;
```

### 補助関数

```ts
// 純関数 (テスト容易)
function buildLgCodeWhereClause(
  columnExpr: string,
  patterns: RegExp[],
): string | undefined;

// Node I/O
async function extractZipsToTemp(
  hubResults: HubSearchResult[],
  tempSubdir: string,
): Promise<string>;  // returns directory path containing extracted .csv files

// src/lib/zip_tools.ts に新規追加
export async function unzipToFiles(
  zipBuffer: Buffer,
  outDir: string,
): Promise<string[]>;  // returns paths of extracted .csv files
```

## 4. データフロー

### 4.1 ステップ 1: temp 展開 (Node 側)

```
cache/files/https___..._mt_rsdtdsp_rsdt_pref01_csv_zip   (既存キャッシュ; 47 都道府県分)
cache/files/https___..._mt_rsdtdsp_rsdt_pos_pref01_csv_zip
                          │
                          ▼ unzipToFiles(buffer, outDir)
tmp/merge-rsdt-duckdb-csv-XXXXX/
├── main/{lg_pref}.csv   (47 ファイル)
└── pos/{lg_pref}.csv    (47 ファイル)
```

- N 個の ZIP を `Promise.all` で並列展開 (zlib は Node スレッドプール)
- ZIP 内 CSV が同名でも `main/{lg_pref}.csv` でユニーク化

### 4.2 ステップ 2: DuckDB セッション初期化

```sql
SET threads = <論理コア数>;
SET preserve_insertion_order = false;
SET temp_directory = '<tmp dir>/duckdb-spill';
PRAGMA memory_limit = '<threads × 3GB>';
```

- DuckDB DB 本体は `tmp/.../db.duckdb` (現コード踏襲)
- temp_directory も temp ルート配下にして finally で一括削除

### 4.3 ステップ 3: ビュー作成

```sql
CREATE VIEW l AS
  SELECT * FROM read_csv_auto('<tmp>/main/*.csv', header=true, parallel=true, all_varchar=true);
CREATE VIEW r AS
  SELECT * FROM read_csv_auto('<tmp>/pos/*.csv',  header=true, parallel=true, all_varchar=true);
```

- `all_varchar=true`: `lg_code` の頭ゼロを保護 (例 `'01100'` を整数化させない)
- VIEW なので materialize なし、JOIN 実行時に並列スキャン

### 4.4 ステップ 4: JOIN + フィルタ + ソート

```sql
SELECT
  l.* REPLACE (
    COALESCE(r.rsdt_addr_flg,      l.rsdt_addr_flg)      AS rsdt_addr_flg,
    COALESCE(r.rsdt_addr_mtd_code, l.rsdt_addr_mtd_code) AS rsdt_addr_mtd_code,
    COALESCE(r.basic_rsdt_div,     l.basic_rsdt_div)     AS basic_rsdt_div
  ),
  r.rep_lon, r.rep_lat, r.rep_srid, r.rep_scale,
  r.rep_src_code, r.rsdt_addr_code_rdbl, r.rsdt_addr_data_mnt_date
FROM l
LEFT JOIN r USING (lg_code, machiaza_id, blk_id, rsdt_id, rsdt2_id)
WHERE <lgCode WHERE 句>   -- settings.lgCodes が指定されている時のみ追加
ORDER BY l.lg_code, l.machiaza_id, l.blk_id, l.rsdt_id, l.rsdt2_id;
```

WHERE 句生成例 (`settings.lgCodes = [/^01/, /^13/]`):

```sql
WHERE regexp_matches(l.lg_code, '^01') OR regexp_matches(l.lg_code, '^13')
```

重複カラム上書きセマンティクスは現 `json_merge_patch(l.data, r.data)` の挙動 (right が left を上書き) を `COALESCE(r.x, l.x)` で再現。

### 4.5 ステップ 5: 結果ストリーミング

```ts
const result = await connection.stream(sql);
for await (const rowObjects of result.yieldRowObjects()) {
  for (const row of rowObjects) {
    yield row as unknown as RsdtdspRsdtDataWithPos;
  }
}
```

- 行は `Record<string, string | null>` 形式
- LEFT JOIN ミスヒット行は pos 側カラムが `null`
- **caller (`03_make_rsdt.ts:232`) を `'rep_srid' in raw` から `raw.rep_srid != null` に修正必須**

### 4.6 ステップ 6: 後始末

```ts
finally {
  try { connection?.closeSync(); } catch { /* ignore */ }
  try { instance?.closeSync(); }   catch { /* ignore */ }
  await fs.rm(tempDir, { recursive: true, force: true })
    .catch((e: unknown) => console.warn(`temp cleanup failed: ${tempDir}`, e));
}
```

## 5. エラー処理と Edge Case

| Edge Case | 対応 |
|---|---|
| ZIP 展開失敗 / 破損 ZIP | `unzipToFiles` で throw → 上位 try で受け、finally で temp 削除 |
| DuckDB 起動失敗 (メモリ/binding) | throw 伝搬。caller の `main().catch()` で exit 1 |
| CSV ヘッダー不一致 (ABR スキーマ変更) | `read_csv_auto` 実行時に DuckDB が「Column not found」を throw。ファイル名がメッセージに含まれる |
| pos 側不在の都道府県 | 現コード踏襲: 事前バリデーションで早期 throw |
| settings.lgCodes が全件不一致 | DuckDB は空結果。yield 0 回。caller の最終 flush 分岐が undefined のままで何も書かない (正しい挙動) |
| temp 削除失敗 | `fs.rm({ force: true })` で best-effort。残骸は次回 mkdtemp で隔離 |
| OOM | `temp_directory` でディスクスピル。それでも足りなければ memory_limit を下げる |
| LEFT JOIN ミスヒット行の null 判定 | `03_make_rsdt.ts:232` を `raw.rep_srid != null` に修正 |
| CSV 行内改行/カンマ/クォート | `read_csv_auto` は RFC 4180 準拠。既存 csv-parse も同じ → テストで担保 |
| 未知の MERGE_BACKEND 値 | 既存パスにフォールバック (`index_dispatch.test.ts` 思想踏襲) |

### リソースリーク防止

AsyncIterator generator の `try/finally` で全リソースを解放。consumer が `break` しても `iterator.return()` が暗黙呼ばれて finally が走る Node ジェネレータ仕様に依拠。

### SQL インジェクション防止

`buildLgCodeWhereClause` で settings.lgCodes 文字列内のシングルクォートを `''` にエスケープ。settings.json はユーザ編集領域として信頼境界外扱い。

### 観測性

- 各ステップ所要時間を `console.log` (extract / view-create / select-start / first-row / last-row)
- `SILENT_MERGE=1` で抑制可能
- `DEBUG_DUCKDB=1` で `EXPLAIN ANALYZE` 出力

## 6. テスト戦略

### 6.1 単体テスト (`merge_duckdb_csv.test.ts`)

1. **`buildLgCodeWhereClause`**: 空配列 → undefined / 1 件 → 単一 regexp_matches / 複数 → OR 連結 / シングルクォート安全エスケープ
2. **`unzipToFiles`**: fixture ZIP から CSV を取り出して outDir に書き出す
3. **`mergeRsdtdspRsdtDataDuckdbCsv` 統合**: fixture (main 3 行, pos 2 行) → 3 行 yield, ミスヒット行 rep_lat=null, ORDER 検証
4. **重複カラム上書き**: 同一キーで main='0', pos='1' → 結果 '1' / pos null → 結果 '0'
5. **settings push down**: lgCodes=['^01'] → 結果が全て '01...' で始まる

### 6.2 等価性テスト (PoC 成立条件)

```sh
SETTINGS_JSON='{"lgCodes":["^01"]}' npm run run:03_make_rsdt
mv out/api out-baseline

SETTINGS_JSON='{"lgCodes":["^01"]}' MERGE_BACKEND=duckdb-csv npm run run:03_make_rsdt
diff -r out-baseline out/api  # 差分なしを期待
```

`-住居表示.txt` バイナリのバイトオフセット含めて完全一致を要求。

### 6.3 ベンチマーク

```
bench-results/
├── 京都府-sqlite-...
├── 京都府-duckdb-...
├── 京都府-duckdb-csv-...   ← 新規
├── 北海道-sqlite-...
├── 北海道-duckdb-...
└── 北海道-duckdb-csv-...   ← 新規
```

判定基準: **既存 DuckDB パス比で `real` 時間 -20% 以上 かつ RSS 同等以下** → PoC 成功。

### 6.4 Lint / Type Check

- `npm run lint`
- `npm run build:dev` (tsc)
- 新規 `merge_duckdb_csv.ts` は `any` ゼロ目標 (DuckDB SDK 型を明示 narrow)

## 7. 今後の派生作業 (out of scope)

- 02 (machi_aza) への展開
- 04 (chiban) は Map fast-path に勝てる戦略を別途検討 (例: CSV パース自体を DuckDB に寄せる)
- 永続 DuckDB ファイル + COPY TO 出力 (Approach 3)
- ORDER BY 緩和による sort buffer 削減 (Tier 4)
- caller 側 (`03_make_rsdt.ts`) の per-machi-aza ループ自体を DuckDB の window function でリプレースする上位 Tier
