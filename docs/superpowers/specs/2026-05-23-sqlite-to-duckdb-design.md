# SQLite → DuckDB 置換と性能検証 設計

- 作成日: 2026-05-23
- 派生元ブランチ: `17-switch-abr-download-site`
- 作業ブランチ: `sqlite-to-duckdb-benchmark`
- 対象モジュール: `src/lib/abr_data/`

## 1. 背景と目的

`src/lib/abr_data/index.ts` の `mergeDataLeftJoin` は、ABR CSV 由来の2つの AsyncIterable を SQLite (better-sqlite3) 上で `JSONB` カラムと `json_patch()` を使い LEFT JOIN マージしている。データパイプライン 02/03/04 の中核処理であり、特に 04 (地番) は `--max-old-space-size=8192` を必要とするほど大規模である。

本作業の目的は、SQLite を DuckDB に置き換えた場合の性能 (wall time / peak RSS) および出力同一性を、再現可能な形で計測すること。SQLite 実装は残し、env 変数で切替可能にする (並行配置)。

### 非ゴール

- SQLite 実装の削除
- 他バックエンド (PostgreSQL、Polars、DataFusion 等) の検証
- 03/04 のロジック改修
- `run:all` フローの変更

## 2. 設計判断の要旨

| 観点 | 採用 | 理由 |
|------|------|------|
| 実装戦略 | **並行配置 (env フラグ)** | 既存呼び出し元を一切変えずに A/B 比較可能 |
| DuckDB binding | **`@duckdb/node-api`** | 公式 NAPI binding、Promise/async iterable ネイティブ、TS型同梱 |
| Dispatcher | `index.ts` で env を読み内部関数を呼ぶ薄い層 | テスト時は内部実装を直接 import 可能に保つ |
| インデックス | DuckDB側は **作らない** | HASH JOIN が equality join で十分高速 |
| ストレージ | `:memory:` 既定、必要時 temp file | 既存の `memory` 引数のセマンティクスを維持 |
| メモリ制御 | `PRAGMA memory_limit='6GB'` | DuckDB は Node heap 外なので 8GB heap 上限と独立に上限設定 |

## 3. アーキテクチャ

```
src/lib/abr_data/
├─ index.ts              [変更] dispatcher: env MERGE_BACKEND を見て分岐
├─ merge_sqlite.ts       [新規] 既存 SQLite 実装を移設 + try/finally
├─ merge_duckdb.ts       [新規] DuckDB 実装 (同インターフェース)
└─ index.test.ts         [変更] 両バックエンドで matrix 実行
```

呼び出し元 (`02_make_machi_aza.ts`, `03_make_rsdt` 経由の `rsdtdsp_rsdt.ts`, `04_make_chiban.ts`) は無変更。

### dispatcher のシグネチャ (index.ts)

```ts
export async function* mergeDataLeftJoin<T, U>(
  left: AsyncIterableIterator<T>,
  right: AsyncIterableIterator<U>,
  keys: string[],
  memory: boolean = false,
): AsyncIterableIterator<T | (T & U)> {
  const backend = process.env.MERGE_BACKEND === 'duckdb' ? 'duckdb' : 'sqlite';
  const impl = backend === 'duckdb' ? mergeDataLeftJoinDuckdb : mergeDataLeftJoinSqlite;
  yield* impl(left, right, keys, memory);
}
```

env 未指定または `'sqlite'` は SQLite 既定 (既存挙動と同じ)。

## 4. データフロー (DuckDB 実装)

```text
1. DuckDBInstance.create(memory ? ':memory:' : <tempDir>/db.duckdb)
   connection = await instance.connect();
   await connection.run("PRAGMA memory_limit='6GB'");

2. CREATE TABLE l (key VARCHAR, data JSON);
   CREATE TABLE r (key VARCHAR, data JSON);

3. Appender API で並列挿入:
   const appL = await connection.createAppender('main', 'l');
   for await (const data of left) {
     appL.appendVarchar(_createKey(data, keys));
     appL.appendVarchar(JSON.stringify(data));   // JSON は文字列経由で投入
     appL.endRow();
   }
   await appL.close();
   // r 側も同様 (Promise.all で並列)

4. インデックスは作らない (HASH JOIN に委譲)

5. ストリーミング SELECT:
   const reader = await connection.stream(`
     SELECT json_merge_patch(l.data, COALESCE(r.data, '{}'::JSON)) AS d01
     FROM l LEFT JOIN r ON l.key = r.key
   `);
   for await (const chunk of reader) {
     for (const row of chunk) yield JSON.parse(row.d01);
   }

6. finally: connection/instance を close、memory=false なら fs.rm(tempDir)
```

### SQLite との等価性表

| SQLite (現行)            | DuckDB (新規)                       | 同等性 |
|-------------------------|-------------------------------------|--------|
| `JSONB` カラム          | `JSON` カラム                       | 同等 (内部表現は異なるが API 等価) |
| `json_patch(a, b)`      | `json_merge_patch(a, b)`            | RFC 7396 同一セマンティクス |
| `coalesce(r.data, '{}')` | `COALESCE(r.data, '{}'::JSON)`     | 同等 (キャスト明示) |
| `prepare(..).iterate()`  | `connection.stream(..)`             | 両方とも遅延ストリーミング |
| 明示 `CREATE INDEX`      | 不要 (HASH JOIN 自動選択)            | DuckDB 側で暗黙最適化 |

## 5. エラー処理とクリーンアップ

- `try { ... } finally { connection.close(); instance.close(); fs.rm(tempDir) }` で異常系でも資源解放
- 同じ修正を `merge_sqlite.ts` 移設時にも適用 (既存 SQLite 版の resource leak を一緒に塞ぐ — 移設に付随する正当な改善)
- async generator が caller 側 `break` で `return()` された場合も generator の finally で解放される

## 6. テスト戦略

### 既存テスト (`src/lib/abr_data/index.test.ts`)

両バックエンドの matrix 化:

```ts
for (const backend of ['sqlite', 'duckdb'] as const) {
  await describe(`mergeDataLeftJoin [${backend}]`, async () => {
    // 既存2ケース + 追加ケースを各 backend で実行
    // 内部実装を直接 import して渡す (env を介さない)
  });
}
```

### 追加テストケース

1. **空入力** — 左空 / 右空 / 両方空
2. **JSON merge セマンティクス** — 右側キーが左側キーを上書き、`null` で削除 (RFC 7396)
3. **大量データ smoke (~100k 行)** — 並列 insert と stream 出力が破綻しないこと
4. **クロスバックエンド等価性** — 同入力で sqlite/duckdb の出力配列が `deepStrictEqual`

## 7. ベンチマーク手順

### 計測スクリプト `scripts/bench/run_bench.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
PREF="$1"          # 京都府 / 北海道
BACKEND="$2"       # sqlite / duckdb
STAMP=$(date +%Y%m%d-%H%M%S)
OUTDIR="bench-results/${PREF}-${BACKEND}-${STAMP}"
mkdir -p "$OUTDIR"

export SETTINGS_JSON="$(cat settings-${PREF}.json)"
export MERGE_BACKEND="$BACKEND"

mv out "out.bak-${STAMP}" 2>/dev/null || true

for step in 02_make_machi_aza 03_make_rsdt 04_make_chiban; do
  /usr/bin/time -l -o "$OUTDIR/${step}.time" \
    npm run "run:${step}" 2>&1 | tee "$OUTDIR/${step}.log"
done

tar -cf "$OUTDIR/out-snapshot.tar" out/api
shasum -a 256 $(find out/api -type f | sort) > "$OUTDIR/checksums.sha256"
```

### 指標と取得元

| 指標                | 取得方法 |
|--------------------|----------|
| wall time          | `/usr/bin/time -l` の `real` |
| peak RSS           | `/usr/bin/time -l` の `maximum resident set size` |
| 出力 byte 一致      | `checksums.sha256` の diff (完全一致が前提) |
| 依存サイズ          | `du -sh node_modules/@duckdb` vs `node_modules/better-sqlite3` |
| install 時間        | `time npm ci` (clean state) |

### 実行マトリクス

```
京都府 × sqlite       京都府 × duckdb
北海道 × sqlite       北海道 × duckdb
```

各 3 反復、中央値を採用。

### 前提ファイル (リポジトリ未追跡、ローカル配置)

- `settings-京都府.json` — `{"lgCodes": ["^26"]}` 等、京都府を抽出する設定
- `settings-北海道.json` — `{"lgCodes": ["^01"]}` 等、北海道を抽出する設定

両ファイルは現在の作業ツリーに既に存在することを確認済み (git untracked)。bench スクリプトはこれらを `SETTINGS_JSON` 環境変数経由で渡す。

### 結果ドキュメント

`docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md` (本設計書とは別ファイル) に表形式で記録。

## 8. 成果物と Done 定義

### コード成果物

- `src/lib/abr_data/index.ts` (dispatcher)
- `src/lib/abr_data/merge_sqlite.ts` (既存実装を移設 + try/finally)
- `src/lib/abr_data/merge_duckdb.ts` (新規 DuckDB 実装)
- `src/lib/abr_data/index.test.ts` (matrix 化 + 追加ケース)
- `scripts/bench/run_bench.sh` (ベンチスクリプト)
- `package.json` (`@duckdb/node-api` を devDependencies に追加)

### ドキュメント成果物

- 本設計書 `docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-design.md`
- 結果報告 `docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md` (実装後追加)

### Done 定義

1. 全テストが `MERGE_BACKEND=sqlite` と `MERGE_BACKEND=duckdb` の両方で green
2. 京都府データで 02/03/04 を流し、両バックエンドの `out/api/` が byte-exact 一致
3. ベンチマーク結果 (4指標 × 2県 × 2backend) が markdown 表として残っている
4. 設計書とベンチ結果がコミット済み、ブランチ push 可能な状態

## 9. リスクと未確定点

- **DuckDB JSON 拡張のロード**: `@duckdb/node-api` 同梱バイナリには JSON 拡張が同梱されているはずだが、`INSTALL json; LOAD json;` が必要な可能性がある → 実装初回に確認
- **Appender の型対応**: JSON カラムへの `appendVarchar` が DuckDB 側で自動キャストされる挙動を実装時に検証
- **JSON_MERGE_PATCH の null 処理**: SQLite と DuckDB で `null` 値の merge セマンティクスに差異があれば、出力 byte 一致が崩れる可能性 → クロスバックエンド等価性テストで早期検出
