# DuckDB Tier 3 (read_csv_auto 直読み) PoC for 04_make_chiban 設計

- 作成日: 2026-05-23
- 派生元ブランチ: `duckdb-tier3-poc-rsdt` (= 03 の PoC ブランチ)
- 作業ブランチ (予定): `duckdb-tier3-poc-rsdt` 継続 (別ブランチを切らない方針)
- 対象モジュール: `src/lib/abr_data/`, `src/processes/04_make_chiban.ts`
- 関連設計書: [`2026-05-23-duckdb-tier3-poc-design.md`](./2026-05-23-duckdb-tier3-poc-design.md) (03 PoC の設計)
- 関連ベンチ結果: [`2026-05-23-sqlite-to-duckdb-bench-results.md`](./2026-05-23-sqlite-to-duckdb-bench-results.md)

## 1. 背景と目的

03_make_rsdt の DuckDB Tier 3 PoC (`MERGE_BACKEND=duckdb-csv`) で、北海道規模では既存 DuckDB 経路比 wall time -55.4% / RSS -5.5% の改善を達成した。本設計はこの Tier 3 アプローチ (CSV 並列スキャン + native LEFT JOIN) を 04_make_chiban に横展開する PoC を再現可能に計測することを目的とする。

ただし 04 は 03 と次の点で構造が大きく異なる:

| 観点 | 03 (rsdt) | 04 (chiban) |
|---|---|---|
| Hub データ粒度 | 都道府県レベル (47 ZIP × 2) | 市区町村レベル (~1887 ZIP × 2) |
| 現状デフォルトの merge | `mergeDataLeftJoin(memory=false)` 経由で SQLite/DuckDB | `mergeDataLeftJoin(memory=true)` で in-memory Map fast-path (SQL backend バイパス) |
| caller の処理粒度 | 全 47 県のストリームを単一の merge に入れ per-machi-aza flush | `processCity` を `CHIBAN_CONCURRENCY=4` で並列、1 自治体 1 ファイル |
| 既存の SQL backend 利用状況 | `MERGE_BACKEND=duckdb` で実利用中 | `memory=true` により `MERGE_BACKEND` の値は無視されている |

このため 03 と同じ単純な「caller に env 分岐を 1 つ足す」では効かず、04 の処理単位 (市区町村) に DuckDB をどう載せるかを別途設計する必要がある。

### 非ゴール

- 02 (machi_aza) への Tier 3 展開
- duckdb-csv 経路を Map fast-path に代わるデフォルトに昇格する PR (PoC 合格後に別タスク)
- 03 の `merge_duckdb_csv.ts` の API シグネチャ変更や汎用化リファクタ
- ChibanData / ChibanPosData の項目追加・削除
- `getHubItemsByQuery` / Hub API の改修
- 永続 DuckDB ファイル化 (将来検討)

## 2. 設計判断の要旨

| 観点 | 採用 | 理由 |
|------|------|------|
| 処理粒度 | **per-city** | caller (`processCity`) の構造変更が最小。Hub item 単位とも一致 |
| API 形態 | **新規モジュール `merge_chiban_duckdb_csv.ts` 追加・既存維持** | 03 の `merge_duckdb_csv.ts` を**触らない**ことで 03 PoC のベンチ再現性を保護 |
| DuckDB ライフサイクル | **`shared` と `percity` の 2 モードを両方実装、PoC で計測して推奨を決定** | per-city は ~1887 回の instance 起動コスト、shared は view 命名と concurrency 設計のコストがあり、机上で勝者が決められない |
| view 名衝突回避 | **`l_<lg_code>` / `r_<lg_code>`** (lg_code は ABR の `[0-9]+` 仕様) | デバッグ可読性 (view 名から自治体が即特定可能)、EXPLAIN ANALYZE 出力の再現性、ランダム性除去 |
| JOIN キー | **`lg_code, machiaza_id, prc_id`** (3 列) | 現状の Map fast-path (`mergeDataLeftJoin(..., ['lg_code', 'machiaza_id', 'prc_id'], true)`) と完全一致 |
| NULL-safe JOIN | **`IS NOT DISTINCT FROM`** | CSV 空フィールドが NULL になる ABR データに対する防御 (03 PoC §4.4 実装中発見) |
| COALESCE オーバーライド | **不要** | ChibanData / ChibanPosData には共通 non-key 列が無いため (03 の `rsdt_addr_flg`, `rsdt_addr_mtd_code`, `basic_rsdt_div` のようなオーバーライド対象が存在しない) |
| ORDER BY | **`COALESCE(col, '')` で全 join key を正規化** | SQLite 経路 (Map fast-path も同様に left 入力順=key 連結順を保証していると仮定) と byte-exact 一致 |
| settings lgCodes push-down | **不要** | 04 の caller は `machiAzaDataByCode` を事前に settings.lgCodes で filter しており、API レベルでは「呼ばれた self は処理対象」と仮定可能 |
| 環境変数 | **`MERGE_BACKEND=duckdb-csv` + `CHIBAN_DUCKDB_LIFECYCLE=shared\|percity`** | 03 と同じ env 名を再利用し、04 専用の lifecycle knob を追加。`CHIBAN_DUCKDB_LIFECYCLE` 未指定時のデフォルトは `shared` (起動コスト 1 回の側を attractive にしておく) |
| 既存 Map fast-path | **温存 (デフォルトのまま)** | PoC の不合格時に production 経路が回帰しないため。`MERGE_BACKEND` 未指定または `duckdb-csv` 以外 → 既存挙動 |
| 出力同一性 | **byte-exact (Map fast-path 比)** | 03 PoC と同じ厳しさ。`diff -r` 0 行を成立条件にする |
| DuckDB スレッド | **`Math.max(1, floor(cores / CHIBAN_CONCURRENCY))`** | `CHIBAN_CONCURRENCY × DuckDB threads` の oversubscribe を防止 |

## 3. アーキテクチャ

```
┌──────────────────────────────────────────────────────────────────────┐
│                     04_make_chiban.ts (caller)                       │
│                                                                      │
│  main():                                                             │
│   ① 町字マスタ取得 (machiAzaDataByCode / machiAzas)                    │
│   ② if (MERGE_BACKEND === 'duckdb-csv')                              │
│        ctx = await createChibanDuckdbCtx(                            │
│          (CHIBAN_DUCKDB_LIFECYCLE ?? 'shared') as ChibanDuckdbLifecycle│
│        );                                                            │
│      else ctx = undefined;                                           │
│   ③ for (ma of machiAzas) {                                          │
│        Promise.race + CHIBAN_CONCURRENCY                             │
│        processCity(ma, machiAzaDataByCode, outDir, ctx)              │
│      }                                                               │
│   ④ if (ctx) await closeChibanDuckdbCtx(ctx);                        │
│                                                                      │
│  processCity():                                                      │
│   ① Hub item 解決 (main + pos?)                                       │
│   ② if (ctx) {                                                       │
│        rawData = mergeChibanDataDuckdbCsv(main, pos, ctx)            │
│      } else {                                                        │
│        // 既存 Map fast-path                                          │
│        mainStream = getAndStreamCSVDataForId(main.id)                │
│        posStream  = pos ? getAndStreamCSVDataForId(pos.id) : empty   │
│        rawData = mergeDataLeftJoin(mainStream, posStream,            │
│                                    ['lg_code','machiaza_id','prc_id'],│
│                                    true)                             │
│      }                                                               │
│   ③ for await (raw of rawData) { per-machi-aza flush, 出力 }          │
└──────────────────────────────────────────────────────────────────────┘
```

```
src/lib/abr_data/
├─ index.ts                          [無変更] 既存 dispatcher
├─ merge_sqlite.ts                   [無変更]
├─ merge_duckdb.ts                   [無変更]
├─ merge_duckdb_csv.ts               [無変更] 03 専用
├─ merge_duckdb_csv.test.ts          [無変更]
├─ chiban.ts                         [追記]  ChibanDataWithPos 型を export
├─ merge_chiban_duckdb_csv.ts        [新規]  PoC 本体
└─ merge_chiban_duckdb_csv.test.ts   [新規]  単体テスト

src/processes/
└─ 04_make_chiban.ts                 [変更]  main() で ctx 生成、processCity で ctx 分岐
```

### 新 API のシグネチャ

```ts
// src/lib/abr_data/chiban.ts (追記)
export type ChibanDataWithPos = ChibanData | ChibanData & ChibanPosData;

// src/lib/abr_data/merge_chiban_duckdb_csv.ts (新規)
export type ChibanDuckdbLifecycle = 'shared' | 'percity';

export interface ChibanDuckdbCtx {
  lifecycle: ChibanDuckdbLifecycle;
  instance?: DuckDBInstance;   // shared 時のみ非 undefined
  tempRoot: string;            // mkdtemp 結果。close 時に recursive rm
}

/** main() 先頭で 1 度呼ぶ。lifecycle に応じ instance を生成 or 空 ctx を返す。 */
export async function createChibanDuckdbCtx(
  lifecycle: ChibanDuckdbLifecycle,
): Promise<ChibanDuckdbCtx>;

/** main() 末尾で 1 度呼ぶ。instance を close し tempRoot を recursive 削除。 */
export async function closeChibanDuckdbCtx(ctx: ChibanDuckdbCtx): Promise<void>;

/** processCity 内で呼ぶ。ctx.lifecycle に応じて instance を取得 or 都度作成。 */
export async function* mergeChibanDataDuckdbCsv(
  mainHubResult: HubSearchResult,
  posHubResult: HubSearchResult | undefined,
  ctx: ChibanDuckdbCtx,
): AsyncIterableIterator<ChibanDataWithPos>;
```

### 共有ヘルパーについて

03 の `merge_duckdb_csv.ts` には `buildLgCodeWhereClause` (純関数) があるが、本 PoC では §2 の通り settings lgCodes push-down 不要なので **import せず使わない**。将来 02 (machi_aza) などへ Tier 3 を横展開する別タスクで、共通ヘルパー (DuckDB セッション初期化 / view 命名 / lgCodes WHERE / temp 管理) を `merge_duckdb_csv_common.ts` に抽出する案を §7 に置いている。本 PoC では 03 のコードに**一切手を入れない**。

## 4. データフロー (per-city 内部)

### 4.1 ステップ 1: temp 展開 (Node 側)

```
cache/files/https___..._mt_parcel_city_mt_parcel_city<lg_code>_csv_zip   (main)
cache/files/https___..._mt_parcel_pos_city_mt_parcel_pos_city<lg_code>_csv_zip  (pos, 任意)
                          │
                          ▼ getDownloadStream + unzipToFiles
ctx.tempRoot/city-<lg_code>/
├── main/{lg_code}.csv     (1 ファイル、数千〜数万行)
└── pos/{lg_code}.csv      (1 ファイル、または無し)
```

- `posHubResult === undefined` のとき pos/ サブディレクトリ自体を作らない (SQL 側で `r_<lg_code>` を作らないので不要)
- `ctx.tempRoot` 配下の `city-<lg_code>/` は process 終了 (または `closeChibanDuckdbCtx`) まで残る (per-city モードでも instance は閉じるが temp は残す方が IO コスト最適)。ただし mkdtemp 単位での隔離は維持

### 4.2 ステップ 2: DuckDB connection 取得

#### `shared` モード

`createChibanDuckdbCtx('shared')` 内で:

```ts
const dbPath = path.join(ctx.tempRoot, 'db.duckdb');
const spillDir = path.join(ctx.tempRoot, 'duckdb-spill');
await fs.mkdir(spillDir, { recursive: true });
ctx.instance = await DuckDBInstance.create(dbPath);
const setup = await ctx.instance.connect();
const cores = os.cpus().length;
const concurrency = parseInt(process.env.CHIBAN_CONCURRENCY ?? '4', 10);
const threads = Math.max(1, Math.floor(cores / concurrency));
const memoryGb = Math.max(2, threads * 3);
await setup.run(`SET threads = ${threads}`);
await setup.run('SET preserve_insertion_order = false');
await setup.run(`SET temp_directory = '${spillDir.replace(/'/g, "''")}'`);
await setup.run(`PRAGMA memory_limit = '${memoryGb}GB'`);
setup.closeSync();
```

processCity 内 (mergeChibanDataDuckdbCsv 内部) で:

```ts
const connection = await ctx.instance.connect();
// view 作成 → クエリ → finally で DROP VIEW + connection.closeSync()
```

各 processCity は独自 connection を持つので、DuckDB の同時クエリ実行がそのまま並列に走る。

#### `percity` モード

createChibanDuckdbCtx は `ctx.tempRoot` だけ用意して instance は作らない (`ctx.instance` undefined)。
mergeChibanDataDuckdbCsv 内で:

```ts
const cityDbDir = path.join(ctx.tempRoot, `db-${lg_code}`);
await fs.mkdir(cityDbDir, { recursive: true });
const instance = await DuckDBInstance.create(path.join(cityDbDir, 'db.duckdb'));
const connection = await instance.connect();
// (shared モードと同じ SET threads / memory_limit / temp_directory 設定)
// → クエリ → finally で connection.closeSync() + instance.closeSync()
//   + cityDbDir も rm (per-city ごとに使い捨て)
```

### 4.3 ステップ 3: ビュー作成

```sql
-- main 必須
CREATE TEMP VIEW l_<lg_code> AS
  SELECT * FROM read_csv_auto(
    '<ctx.tempRoot>/city-<lg_code>/main/*.csv',
    header=true, parallel=true, all_varchar=true
  );

-- pos 任意 (posHubResult が存在する自治体のみ)
CREATE TEMP VIEW r_<lg_code> AS
  SELECT * FROM read_csv_auto(
    '<ctx.tempRoot>/city-<lg_code>/pos/*.csv',
    header=true, parallel=true, all_varchar=true
  );
```

- `all_varchar=true`: `lg_code` の先頭ゼロを保護
- `parallel=true`: DuckDB は内部で複数 CSV reader を並列に動かす (CSV が 1 ファイルでも並列読みは効く)
- TEMP VIEW は connection scope なので shared モードでも他 connection から見えない (= 並列 city 間の view 衝突は理論上発生しない)。ただしデバッグ容易性のため lg_code suffix は維持

### 4.4 ステップ 4: JOIN + ソート

#### pos あり自治体

```sql
SELECT
  l.*,
  r.rep_lon,
  r.rep_lat,
  r.rep_srid,
  r.rep_scale,
  r.rep_src_code
FROM l_<lg_code> AS l
LEFT JOIN r_<lg_code> AS r
  ON l.lg_code     IS NOT DISTINCT FROM r.lg_code
 AND l.machiaza_id IS NOT DISTINCT FROM r.machiaza_id
 AND l.prc_id      IS NOT DISTINCT FROM r.prc_id
ORDER BY
  COALESCE(l.lg_code, ''),
  COALESCE(l.machiaza_id, ''),
  COALESCE(l.prc_id, '');
```

#### pos なし自治体

```sql
SELECT
  l.*,
  NULL AS rep_lon,
  NULL AS rep_lat,
  NULL AS rep_srid,
  NULL AS rep_scale,
  NULL AS rep_src_code
FROM l_<lg_code> AS l
ORDER BY
  COALESCE(l.lg_code, ''),
  COALESCE(l.machiaza_id, ''),
  COALESCE(l.prc_id, '');
```

caller (`04_make_chiban.ts:146`) は `'rep_srid' in raw ? projectABRData(raw) : undefined` で pos の有無を判定しているが、LEFT JOIN は **全カラムを持った row** を返すので、03 PoC と同じく `raw.rep_srid != null` に修正する必要がある (03 PoC でも同じ修正を caller に入れた)。

### 4.5 ステップ 5: 結果ストリーミング

```ts
const result = await connection.stream(sql);
for await (const rowObjects of result.yieldRowObjects()) {
  for (const row of rowObjects) {
    yield row as unknown as ChibanDataWithPos;
  }
}
```

行は `Record<string, string | null>` 形式。LEFT JOIN ミスヒット行は pos 側カラムが `null`。

### 4.6 ステップ 6: 後始末 (per-city)

```ts
finally {
  try {
    await connection.run(`DROP VIEW IF EXISTS l_${lg_code}`);
    if (posHubResult) {
      await connection.run(`DROP VIEW IF EXISTS r_${lg_code}`);
    }
  } catch { /* ignore */ }
  try { connection.closeSync(); } catch { /* ignore */ }
  if (ctx.lifecycle === 'percity') {
    try { instance.closeSync(); } catch { /* ignore */ }
    await fs.rm(cityDbDir, { recursive: true, force: true }).catch((e) =>
      console.warn(`merge_chiban_duckdb_csv: cityDbDir cleanup failed: ${cityDbDir}`, e),
    );
  }
  // city-<lg_code>/ (CSV temp) は close 側で一括 rm するため per-city では削除しない
}
```

### 4.7 ステップ 7: 全体終了 (`closeChibanDuckdbCtx`)

```ts
if (ctx.instance) {
  try { ctx.instance.closeSync(); } catch { /* ignore */ }
}
await fs.rm(ctx.tempRoot, { recursive: true, force: true }).catch((e) =>
  console.warn(`merge_chiban_duckdb_csv: tempRoot cleanup failed: ${ctx.tempRoot}`, e),
);
```

## 5. エラー処理と Edge Case

| Edge Case | 対応 |
|---|---|
| pos データ無し自治体 | `posHubResult === undefined` を API が分岐、`SELECT l.*, NULL AS rep_lon, ...` の SQL を発行 |
| 自治体に main データ無し | caller (`processCity`) の `if (!chibanDataRef) return` で早期 return。API には到達しない |
| main CSV が 0 行 | DuckDB は空結果を返し yield 0 回。caller の `currentChibanList.length > 0` チェックで何も書かれない (現状挙動と一致) |
| ZIP 展開失敗 / 破損 ZIP | `unzipToFiles` で throw → API の try で catch、finally で view DROP + temp 削除 |
| DuckDB 起動失敗 (メモリ/binding) | throw 伝搬。caller の `main().catch()` で exit 1 |
| CSV ヘッダ不一致 (ABR スキーマ変更) | `read_csv_auto` 実行時に DuckDB が "Column not found" を throw |
| 並列 city 間で同じ lg_code が来る | 04 caller は `machiAzaDataByCode` の de-dup 済みで起きない前提。仮に起きても TEMP VIEW は connection scope なので shared モードでも衝突しない |
| Ctrl-C / プロセス強制終了 | `ctx.tempRoot` の cleanup は best-effort。次回起動時は新しい mkdtemp で隔離されるので残骸は影響しない |
| view DROP 漏れ (例外時) | finally で `DROP VIEW IF EXISTS` を実行。`IF EXISTS` で冪等 |
| LEFT JOIN ミスヒット行の null 判定 | caller (`04_make_chiban.ts:146`) を `'rep_srid' in raw` から `raw.rep_srid != null` に修正必須 |
| 未知の `CHIBAN_DUCKDB_LIFECYCLE` 値 | API 入り口で `'shared' \| 'percity'` のいずれでもなければ throw (早期失敗) |
| `lg_code` が `[0-9]+` 以外 | API 入り口で `/^[0-9]+$/` validate、不一致は throw (SQL identifier 安全性確保) |

### リソースリーク防止

AsyncIterator generator の `try/finally` で全リソースを解放。consumer (caller の for-await) が `break` しても `iterator.return()` が暗黙呼ばれて finally が走る Node ジェネレータ仕様に依拠 (03 PoC と同じ前提)。

### SQL インジェクション境界

- `lg_code` は ABR の `[0-9]+` 仕様。API 入り口で `/^[0-9]+$/` validate (新規追加)
- temp ディレクトリパスは 03 と同じく single-quote エスケープ (`replace(/'/g, "''")`)
- view 名は `l_<lg_code>` / `r_<lg_code>` で lg_code が validate 済なので template literal で安全

### 観測性 (deferred)

- 各ステップ所要時間の console.log は MVP 成立条件 (byte-exact / RSS) には不要なので本 PoC では入れない
- 不合格時の `EXPLAIN ANALYZE` 取得は手動で `connection.run('EXPLAIN ANALYZE <sql>')` を一時挿入

## 6. テスト戦略

### 6.1 単体テスト (`merge_chiban_duckdb_csv.test.ts`)

ライフサイクル両モード (`shared` / `percity`) で同じシナリオを matrix 実行 (テスト helper で lifecycle を引数化):

1. **基本 LEFT JOIN**: main 3 行 (lg_code=011002 prc_id=001/002/003) + pos 2 行 (prc_id=001/002) → 全 3 行 yield、prc_id=003 行は `rep_lat=null`
2. **pos 無し自治体**: `posHubResult=undefined` → 全 main 行 yield、pos 列は全て null。出力 row 数は main の行数と一致
3. **JOIN キー NULL-safe**: CSV の空フィールド (例: `koaza=''`) が NULL になるが、JOIN は `lg_code + machiaza_id + prc_id` のみで判定するので結果に影響しないことを確認
4. **ORDER BY 安定性**: 同一 `lg_code, machiaza_id` 配下で `prc_id` が昇順 (`COALESCE(prc_id, '')` 適用)
5. **lg_code validation**: API 入り口で `/^[0-9]+$/` 不一致 (例: `'abc'`) を投入 → throw
6. **shared モードの順次投入**: 同じ instance に異なる 2 自治体 (lg_code=011002, 131059) を順に投入 → 両方正しい結果、view DROP 漏れなし
7. **shared モードの並列投入**: `Promise.all` で 2 自治体を同時に投入 → 両方正しい結果。TEMP VIEW が connection scope なので干渉なし
8. **temp cleanup on break**: consumer が途中 break しても city-<lg_code>/ 配下が closeChibanDuckdbCtx 後に残らない (shared/percity 両モード)、per-city モードは `db-<lg_code>/` がクエリ終了直後に消える
9. **lifecycle 値 validation**: `CHIBAN_DUCKDB_LIFECYCLE='invalid'` で `createChibanDuckdbCtx` 呼出 → throw (早期失敗)

フィクスチャは `test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/` に小規模 ZIP を 2 つ用意 (main.zip / pos.zip + 別 lg_code の small.main.zip)。

### 6.2 等価性テスト (PoC 成立条件)

```bash
# 1) 北海道で baseline (Map fast-path = 現状デフォルト)
rm -rf out/api
SETTINGS_JSON="$(cat settings-北海道.json)" npm run run:04_make_chiban
mv out/api out-baseline-chiban

# 2) duckdb-csv-percity
SETTINGS_JSON="$(cat settings-北海道.json)" \
  MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE=percity \
  npm run run:04_make_chiban
diff -r out-baseline-chiban out/api | tee /tmp/chiban-percity.diff
wc -l /tmp/chiban-percity.diff   # 0 行を期待

# 3) duckdb-csv-shared
rm -rf out/api
SETTINGS_JSON="$(cat settings-北海道.json)" \
  MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE=shared \
  npm run run:04_make_chiban
diff -r out-baseline-chiban out/api | tee /tmp/chiban-shared.diff
wc -l /tmp/chiban-shared.diff    # 0 行を期待
```

両モードとも `-地番.txt` のバイナリ完全一致を要求。差分が出た場合の切り分け指針:

| 症状 | 疑うべき箇所 |
|------|-------------|
| 全ファイルでサイズ差 | header chunk size (`HEADER_CHUNK_SIZE`) の整合性。caller 側で list 順序が変わっていないか確認 |
| 数ファイルだけサイズ差 | LEFT JOIN ミスヒット行の null 判定。`raw.rep_srid != null` が空文字 `""` で意図せず弾いていないか確認 |
| サイズは同じだがバイナリ差 | ORDER BY の secondary sort 差。`COALESCE(col, '')` が漏れている key が無いか確認 |
| 京都府の `（耕）7-7` 系の collation 差 | 03 PoC の bench-results.md と同じ全角括弧 collation 差の可能性。本 PoC では `COALESCE` で SQLite 経路と同じ順を再現する想定 |

### 6.3 ベンチマーク (PoC 判定)

3 backends を京都府 + 北海道で計測:

| backend | env |
|---|---|
| baseline (現状 Map) | `MERGE_BACKEND` 未設定 |
| duckdb-csv-percity | `MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE=percity` |
| duckdb-csv-shared | `MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE=shared` |

成果物は `bench-results/04-{京都府,北海道}-{baseline,duckdb-csv-percity,duckdb-csv-shared}-<TS>/` に格納。

判定基準 (2 軸):

- **lifecycle 選定**: `shared` vs `percity` の wall time / peak RSS を比較し、勝った方をデフォルト推奨 (`CHIBAN_DUCKDB_LIFECYCLE` 未指定時のデフォルト) として設計書 §2 の表を更新
- **昇格判断 (Map fast-path との比較)**: 勝った lifecycle で Map fast-path 比 wall time -20% 以上 かつ peak RSS 同等以下 を満たせば、`MERGE_BACKEND=duckdb-csv` を 04 のデフォルトに昇格する別 PR を起案。京都府で届かない場合は 03 PoC と同じく workload-size limitation として許容 (北海道規模で評価)

結果は `docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md` の末尾に「Tier 3 PoC for 04_make_chiban」セクションを追記。

### 6.4 Lint / Type Check

- `npm run lint`
- `npm run build:dev` (tsc)
- 新規 `merge_chiban_duckdb_csv.ts` は `any` ゼロ目標 (DuckDB SDK 型を明示 narrow)

## 7. 今後の派生作業 (out of scope)

- 02 (machi_aza) への Tier 3 横展開
- duckdb-csv 経路をデフォルトに昇格する PR (PoC 数値が合格してから別タスク)
- 03 と 04 で重複する temp 管理 / DuckDB セッション設定 / view 命名規約を `merge_duckdb_csv_common.ts` に抽出する汎用化リファクタ
- 永続 DuckDB ファイル化 (現状の `tmp/...db.duckdb` を `cache/.duckdb-state` 等に保持してビュー再構築コストを償却)
- per-city モードで複数 self を 1 DuckDB instance に同時投入する「ミニ shared」中間モード (現状の 2 モード比較で明確に決着が付かなかった場合に検討)
