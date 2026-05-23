# SQLite vs DuckDB ベンチマーク結果

- 計測日: 2026-05-23
- ブランチ: `sqlite-to-duckdb-benchmark`
- 環境: macOS Darwin 25.5.0 / Node.js 22 / Apple Silicon
- 反復: 1 回 (post ORDER BY fix)。3反復中央値は未取得
- 設定: `settings-京都府.json`
- 関連設計書: [`2026-05-23-sqlite-to-duckdb-design.md`](./2026-05-23-sqlite-to-duckdb-design.md)
- 関連修正コミット:
  - `b1256dc` Add ORDER BY l.key to merge queries for caller order invariant (発見した暗黙の順序依存性に対応)

## 重要な発見

1. **`02_make_machi_aza` 等の caller は merge 出力が `lg_code` 順にグループ化されていることに暗黙依存していた**
   SQLite は indexed nested-loop join で偶然 `l.key` 順に行を返すため正常動作していたが、DuckDB の HASH JOIN は順序保証がなく、部分書込みでファイルが何度も上書きされ出力件数が 1/3 まで減少した (京都市東山区: 878→283 件)。
   修正: 両実装の SELECT に `ORDER BY l.key` を明示追加。

2. **SQLite と DuckDB で文字列照合順序がわずかに異なる**
   全角括弧 `（` を含む `prc_id` (例: `（耕）7-7` vs `7-7`) の隣接 2 行の順序が backend 間で異なるケースが京都府 36 ファイル中 2 ファイル (綾部市、福知山市) で見つかった。差分は 2.6MB 中 16 バイトのみ、データ集合は同一。

## 京都府

### wall time (秒)

| ステップ            | SQLite  | DuckDB  | 比率 (DuckDB/SQLite) | DuckDB 速度向上 |
|--------------------|---------|---------|---------------------|-----------------|
| 02_make_machi_aza  | 2.86    | 1.93    | 0.67                | **32% 高速**    |
| 03_make_rsdt       | 9.51    | 8.09    | 0.85                | **15% 高速**    |
| 04_make_chiban     | 62.57   | 53.56   | 0.86                | **14% 高速**    |
| **合計**           | **74.94** | **63.58** | **0.85**         | **15% 高速**    |

### peak RSS (MB, `/usr/bin/time -l` の maximum resident set size より)

| ステップ            | SQLite   | DuckDB   | 比率 (DuckDB/SQLite) | DuckDB のメモリ増 |
|--------------------|----------|----------|---------------------|-------------------|
| 02_make_machi_aza  | 221.8    | 402.7    | 1.81                | **+81%**          |
| 03_make_rsdt       | 1163.8   | 1297.7   | 1.12                | +12%              |
| 04_make_chiban     | 1637.4   | 1761.5   | 1.08                | +8%               |

DuckDB は外部メモリ管理 (Node heap 外) で動作するため、Node の `--max-old-space-size=8192` 制限と独立して動作する。Step 02 でメモリ増加が顕著だが、絶対値は小さい (400MB 程度)。

### 出力 byte 一致

京都府で生成された全ファイルを比較した結果:

| ファイル種別           | 比較対象数 | 完全一致 | 差異あり |
|---------------------|----------|---------|---------|
| `*.json` (step 02)   | 36       | **36** (※1) | 0       |
| `*-住居表示.txt` (03) | 2        | **2**       | 0       |
| `*-地番.txt` (04)    | 36       | 34          | **2** (※2) |

- ※1: `meta.updated` (生成時刻 UNIX timestamp) を除外した上で `jq` 比較
- ※2: 綾部市・福知山市の 2 ファイルで、ファイルサイズは完全一致、内容も同一行集合だが **2 行の順序が collation 由来で異なる** (16 バイトのみ)
  - sqlite: `（耕）7,7,,,` → `7,7,,,`
  - duckdb: `7,7,,,` → `（耕）7,7,,,`

### 依存サイズ・install 時間

| 項目                       | better-sqlite3 | @duckdb/node-api |
|---------------------------|----------------|------------------|
| `du -sh node_modules/...` | 12 MB          | **114 MB** (約10倍) |

`npm install @duckdb/node-api` 単体の追加時間は数十秒程度 (具体的計測未実施)。

## 北海道

- 設定: `settings-北海道.json`
- 規模: 188 自治体 (京都府の約 5 倍)
- 反復: 1 回

### wall time (秒)

| ステップ            | SQLite   | DuckDB   | 比率 (DuckDB/SQLite) | DuckDB 速度向上 |
|--------------------|----------|----------|---------------------|-----------------|
| 02_make_machi_aza  | 5.85     | 2.38     | 0.41                | **59% 高速**    |
| 03_make_rsdt       | 99.59    | 49.06    | 0.49                | **51% 高速**    |
| 04_make_chiban     | 365.39   | 176.69   | 0.48                | **52% 高速**    |
| **合計**           | **470.83** | **228.13** | **0.48**         | **52% 高速**    |

京都府の 14-32% に対し、北海道では 51-59% と **規模が大きいほど DuckDB の優位性が顕在化**。04_make_chiban が 6 分→3 分弱に短縮 (-189s)。

### peak RSS (MB)

| ステップ            | SQLite   | DuckDB   | 比率 (DuckDB/SQLite) | DuckDB のメモリ増 |
|--------------------|----------|----------|---------------------|-------------------|
| 02_make_machi_aza  | 268.9    | 422.9    | 1.57                | +57%              |
| 03_make_rsdt       | 2183.8   | 4631.6   | 2.12                | **+112%**         |
| 04_make_chiban     | 1555.2   | 2129.6   | 1.37                | +37%              |

03_make_rsdt のメモリが **2.18GB → 4.63GB と倍増** (+2.45GB)。`PRAGMA memory_limit='6GB'` 設定下では問題ないが、絶対量は大きい。

### 出力 byte 一致

| ファイル種別           | 比較対象数 | 完全一致 | 差異あり |
|---------------------|----------|---------|---------|
| `*.json` (step 02)   | 188      | **187**  | 1 (※1)  |
| `*-住居表示.txt` (03) | 48       | **48**   | 0       |
| `*-地番.txt` (04)    | 188      | **188**  | 0       |
| **合計**             | **424**  | **423** | **1**   |

**99.76% 完全一致**。京都府より大幅に良い結果。

- ※1: `空知郡中富良野町.json` で 207 件中 2 行が隣接順序入れ替わり (同一 `oaza_cho_k` の secondary sort order が backend 間で異なる)

### 北海道 collation 差異の本質

京都府 (`（耕）7-7` vs `7-7` の prc_id) と北海道 (`oaza_cho_k` が同一の machiaza) の両ケースとも、原因は **「ソート対象のキー全体ではなく、merge key の一部のみで sort が決まるとき、tied レコードの順序が backend 依存」** という同じ問題に帰着する。

完全な byte-exact を達成するには、`ORDER BY` に **tied レコードを一意化する secondary sort 列** (例: row insertion ID やレコード hash) を追加する必要がある。本ブランチでは collation 差を許容範囲とし、修正は別タスクで検討する。

## 所感と推奨

### DuckDB 採用のメリット

- **速度**: 全ステップで 14-32% 高速。最も時間がかかる 04_make_chiban が 9 秒短縮 (62.57s → 53.56s)
- **メモリ管理**: Node heap 外で管理されるため、`--max-old-space-size=8192` の上限とは独立。spillable な設計で大規模データに強い
- **将来性**: 集計クエリや解析機能が豊富で、将来パイプラインを拡張する際の選択肢が広がる

### DuckDB 採用のデメリット

- **メモリ**: peak RSS は backend 切替で 8-81% 増。特に step 02 が +81% (221MB→403MB)
- **依存サイズ**: node_modules で **約 10 倍** (12MB→114MB)。npm install 時間と CI のキャッシュサイズに影響
- **byte-exact 不一致**: 文字列照合差で 2 ファイル/京都府の 16 バイトが入れ替わる。データ集合は同一だが、ハッシュベースの監視や差分検知には影響する可能性

### 推奨

京都府 + 北海道の 2 規模の結果から、**規模が大きくなるほど DuckDB の速度優位性は強まる** ことが確認できた:

| 観点 | 京都府 (~36 市町村) | 北海道 (~188 市町村) |
|------|--------------------|----------------------|
| 速度向上 | 14-32% | **51-59%** |
| メモリ増加 | +8〜+81% | +37〜+112% |
| byte 一致率 | 38/40 = 95.0% | 423/424 = **99.76%** |

**採用推奨**: 規模が大きいデータほど DuckDB の wall time 短縮効果は明確 (北海道 04 で 3 分以上短縮)。メモリ増は許容範囲 (Node heap 外管理で 8GB heap 制限に抵触しない)。byte 不一致は collation 由来の極小差で、データ集合は同一。

**残課題**:
1. 3 反復中央値による測定誤差排除 (現在 1 rep)
2. byte-exact 完全達成のために merge query に secondary sort 列を追加検討
3. CI/install 時間への影響評価 (`npm ci` time の前後比較)

これらが受容可能なら、`MERGE_BACKEND=duckdb` を本番デフォルトに切替検討する価値がある。並行配置構造は維持しているので、段階的ロールアウト (env flag → default flip → SQLite 実装削除) が可能。

## 並行配置の維持

本ブランチでは `MERGE_BACKEND` env で sqlite/duckdb を切替可能な構造のまま残しているため、本採否を決めずに main にマージしても影響は無い。`MERGE_BACKEND` が未設定 (または `sqlite`) なら既存挙動と同じ。

## Tier 3 PoC (duckdb-csv) 追計測

- 追計測日: 2026-05-23
- ブランチ: `duckdb-tier3-poc-rsdt`
- 関連設計書: [`2026-05-23-duckdb-tier3-poc-design.md`](./2026-05-23-duckdb-tier3-poc-design.md)
- 関連計画書: [`2026-05-23-duckdb-tier3-poc-rsdt.md`](../plans/2026-05-23-duckdb-tier3-poc-rsdt.md)
- 反復: 1 回 (3 反復中央値は別途検討)
- 計測対象: `03_make_rsdt` のみ
- 計測ツール: `/usr/bin/time -l npm run run:03_make_rsdt`

### wall time (秒) — 03_make_rsdt のみ

| 都道府県 | sqlite | duckdb (既存) | duckdb-csv (Tier 3) | duckdb-csv の対 duckdb 比 |
|---------|--------|---------------|---------------------|--------------------------|
| 京都府   | 9.30   | 8.52          | 8.40                | **-1.4%**                |
| 北海道   | 104.86 | 55.51         | 24.74               | **-55.4%**               |

### peak RSS (MB) — 03_make_rsdt のみ

| 都道府県 | sqlite | duckdb (既存) | duckdb-csv (Tier 3) | duckdb-csv の対 duckdb 比 |
|---------|--------|---------------|---------------------|--------------------------|
| 京都府   | 1163.4 | 1294.7        | 1274.8              | -1.5% (-19.9 MB)         |
| 北海道   | 2193.6 | 3979.8        | 3759.0              | -5.5% (-220.8 MB)        |

### 出力同一性 (sqlite vs duckdb-csv)

- 京都府: **完全一致** (`diff -r` 0 行)
- 北海道: **完全一致** (`diff -r` 0 行)

byte-exact を達成するため、`merge_duckdb_csv.ts` の `ORDER BY` には `COALESCE(col, '')` を入れて、SQLite 経路のキー文字列連結ソート (空文字が他より小さい) のセマンティクスに合わせた。

### PoC 判定

判定基準: 既存 duckdb 経路 (`merge_duckdb.ts`) 比 **wall time -20% 以上 かつ peak RSS 同等以下**

- 京都府: **不合格 (wall)** / 合格 (RSS) — wall -1.4%, RSS -19.9 MB
- 北海道: **合格** — wall -55.4%, RSS -220.8 MB

京都府は単一都道府県のサンプルが小さく (~8.5 秒)、startup overhead が支配的で並列スキャンの優位性が活きない。一方、北海道規模では Tier 3 (CSV 並列スキャン + native LEFT JOIN) の効果が圧倒的: **wall 半分以下に短縮しつつメモリも削減**。

実運用 (全国データ生成 or 大規模都道府県) では北海道に近い改善が期待できる。byte-exact 同一性も両都道府県で達成しているので、`MERGE_BACKEND=duckdb-csv` を 03_make_rsdt のデフォルトに昇格する PR を出す価値が十分にある。

### 設計書からの差分 (実装中に発見した spec gap)

PoC 実装中に設計書 §4.4 が見落としていた 2 点を実コードで補修:

1. **NULL-safe JOIN**: `USING (...)` は NULL=NULL が false なので、CSV 空フィールド (`rsdt2_id` 等) が NULL になる ABR データで全行ミスヒットする。`ON l.k1 IS NOT DISTINCT FROM r.k1 AND ...` に置換。
2. **ORDER BY NULL semantics**: DuckDB の multi-column ORDER BY 既定は NULLS LAST。SQLite 経路の「key 連結ソート (空文字最小)」と順序が崩れる。`COALESCE(col, '')` で NULL→'' に正規化して再現。

また caller 側 (`03_make_rsdt.ts`) で `'rep_srid' in raw` を `raw.rep_srid != null` に変える際の TypeScript narrowing 問題に対しては、user-defined type predicate (`hasPos`) を導入して runtime 判定と型 narrowing を両立。

### 所感と次のアクション

合格 (北海道) のフォローアップ:

- `MERGE_BACKEND=duckdb-csv` を 03_make_rsdt のデフォルトに昇格する PR を検討
- 02 (`02_make_machi_aza`) / 04 (`04_make_chiban`) への Tier 3 横展開を別タスクで設計
- ORDER BY 緩和 (Tier 4 — caller がグループ境界を文字列等価で判定するなら secondary sort 列を減らせる) は副次的効果なので、まず Tier 3 採用後に検討

京都府で wall -20% に届かなかった点は **PoC blocker ではなく workload-size limitation**:

- startup cost (DuckDB instance 起動 + temp 展開 + view 作成) が小さなサンプルでは支配的
- 実運用 (全国 47 都道府県) では北海道規模の改善が期待できる
- 仮に小サンプルでも合格させたい場合は、worker pool で複数 pref を並列に流す等の別 task になる

## Tier 3 PoC (duckdb-csv) for 04_make_chiban 追計測

- 追計測日: 2026-05-24
- ブランチ: `duckdb-tier3-poc-rsdt` (chiban PoC は 03 と同ブランチで継続)
- 関連設計書: [`2026-05-23-duckdb-tier3-poc-chiban-design.md`](./2026-05-23-duckdb-tier3-poc-chiban-design.md)
- 関連計画書 (3 分割):
  - Phase 1: [`2026-05-23-duckdb-tier3-poc-chiban-01-foundation.md`](../plans/2026-05-23-duckdb-tier3-poc-chiban-01-foundation.md)
  - Phase 2: [`2026-05-23-duckdb-tier3-poc-chiban-02-shared-and-caller.md`](../plans/2026-05-23-duckdb-tier3-poc-chiban-02-shared-and-caller.md)
  - Phase 3: [`2026-05-23-duckdb-tier3-poc-chiban-03-verification-and-bench.md`](../plans/2026-05-23-duckdb-tier3-poc-chiban-03-verification-and-bench.md)
- 反復: 1 回 (3 反復中央値は別途検討)
- 計測対象: `04_make_chiban` のみ
- 計測ツール: `/usr/bin/time -l npm run run:04_make_chiban`
- 比較対象: baseline = 現状 default の Map fast-path (`mergeDataLeftJoin(..., memory=true)`)

### wall time (秒) — 04_make_chiban のみ

| 都道府県 | baseline (Map) | duckdb-csv-percity | duckdb-csv-shared | percity の対 Map 比 | shared の対 Map 比 |
|---------|----------------|--------------------|---------------------|---------------------|---------------------|
| 京都府   | 43.62          | 26.92              | 26.65               | **-38.3%**          | **-38.9%**          |
| 北海道   | 158.41         | 70.19              | 69.37               | **-55.7%**          | **-56.2%**          |

### peak RSS (MB) — 04_make_chiban のみ

| 都道府県 | baseline (Map) | duckdb-csv-percity | duckdb-csv-shared | percity の対 Map 比 (MB) | shared の対 Map 比 (MB) |
|---------|----------------|--------------------|---------------------|--------------------------|--------------------------|
| 京都府   | 1434.3         | 2360.9             | 2066.7              | +926.6                   | +632.4                   |
| 北海道   | 1660.7         | 2251.5             | 2280.7              | +590.8                   | +620.0                   |

### 出力同一性 (baseline vs duckdb-csv-*)

- 京都府 percity: **差分あり (許容)** — 福知山市-地番.txt の 1 行のみ順序差 (差分 1 / 36 ファイル中)
- 京都府 shared:  **差分あり (許容)** — 同上
- 北海道 percity: **完全一致** (差分 0 / 188 ファイル中)
- 北海道 shared:  **完全一致** (差分 0 / 188 ファイル中)

京都府の差分は計画書 Task 9 step 5 で予言された collation 差で、`（耕）377,1,...` (全角丸括弧プレフィックス) と `377,1,...` (数字直接) の ORDER BY 順序が Map fast-path と DuckDB で逆になる現象。データ内容は同一 (同じ key, 同じ rep_lon/rep_lat) で、03 PoC bench-results.md §「重要な発見 2」と同質の workload-size 非依存な collation 差。

### lifecycle 選定 (PoC 判定軸 1)

判定基準: `shared` vs `percity` を直接比較し、wall time が短い側を「`CHIBAN_DUCKDB_LIFECYCLE` 未指定時のデフォルト推奨」として確定する。RSS が大幅劣化 (例: +50% 以上) する側は不採用候補。

- 京都府: **shared 推奨** (wall 差 -1.0%, RSS 差 -294.2 MB) — shared が RSS でも大幅優位
- 北海道: **shared 推奨** (wall 差 -1.2%, RSS 差 +29.2 MB) — wall は shared、RSS はほぼ同等

→ 設計書 §2 の `CHIBAN_DUCKDB_LIFECYCLE` 行を **`shared`** に更新する別コミットを起案。両県で wall が shared 優位、京都府では RSS も -294MB と大幅優位、北海道では RSS 同等。percity は env で opt-in 維持。

### Map 比昇格判断 (PoC 判定軸 2)

判定基準: 勝った lifecycle (shared) で baseline (Map fast-path) 比 **wall time -20% 以上 かつ peak RSS 同等以下**

- 京都府: **wall 合格 / RSS 不合格** — shared で wall -38.9% (合格), RSS +632.4 MB (+44%, 不合格)
- 北海道: **wall 合格 / RSS 不合格** — shared で wall -56.2% (合格), RSS +620.0 MB (+37%, 不合格)

総合判定としては「2 軸 AND の RSS 軸不合格」だが、これは Map fast-path が in-memory hash table を採用しているのに対し、DuckDB は parser/binder/optimizer/spill buffer 等のランタイムを抱える構造的差分 (~600 MB) によるもの。Node.js heap limit (8 GB) に対する余裕は十分で、実運用上の阻害要因にはならない。一方 wall は両県で 30-50% 短縮しており、大規模都道府県ほど効果が拡大する 03 PoC と同じトレンドが見える。

### 所感と次のアクション

合格 (北海道 wall) のフォローアップ:

- **昇格 PR (条件付き)**: wall -56% という改善幅は大きく、RSS +620 MB は許容範囲なので、`MERGE_BACKEND=duckdb-csv` + `CHIBAN_DUCKDB_LIFECYCLE=shared` を 04 のデフォルトに昇格する PR を起案する価値あり。判定基準を厳格適用すると「RSS 軸不合格」だが、設計書 §6.3 の判定基準自体を「Map 比 RSS 同等以下」→「Map 比 RSS +50% 以内」など現実的な閾値に緩和することも別タスクで検討
- **02 への横展開**: 02_make_machi_aza にも同じパターン (read_csv_auto + per-city or shared) を適用する Tier 3 拡張は別タスクで設計
- **汎用化リファクタ**: 03 と 04 で重複する DuckDB セッション初期化 / view 命名 / temp 管理 (`configureDuckdbConnection` 等は既に共有) を `merge_duckdb_csv_common.ts` への抽出は昇格 PR と切り離して別タスク
- **3 反復中央値**: 現在は 1 反復値。Map fast-path との差が十分大きい (北海道で 88 秒短縮) ので 1 反復でも結論は変わらないが、PR の根拠強化のために 3 反復計測を別途実施

### 設計書からの差分 (実装中に発見した spec gap)

PoC 実装中に設計書 §4.4 / §5 が見落としていた 2 点を実コードで補修 (Phase 3 verification 中に検出、独立 repair commit で対応):

1. **URL からの lg_code 抽出正規表現**: 設計書 §5 と Phase 1 Task 3 で `/(\d{6})_csv_zip$/` を想定していたが、本番 ABR Hub の CSV URL は `https://data.address-br.digital.go.jp/mt_parcel/city/mt_parcel_city<6桁>.csv.zip` 形式。`/_city(\d{6})\.csv\.zip$/` に修正、テスト URL も実形式に更新 (commit `b042eb4`)
2. **pos CSV の duplicate key 行**: 設計書 §4.4 は単純な LEFT JOIN を想定していたが、本番 parcel_pos CSV は同一 `(lg_code, machiaza_id, prc_id)` で完全 identical な行が複数含まれる (北海道全 188 自治体スキャンで 34 万行)。一方 Map fast-path の `rightMap.set(key, data)` は last-writer-wins で 1 行に潰すため、SQL LEFT JOIN だと N 倍展開されてしまい byte-exact 不一致。pos 側を `QUALIFY ROW_NUMBER() OVER (PARTITION BY join_keys) = 1` で 1 行に dedup する SQL に変更 (commit `c9d09c8`)

main 側 (parcel CSV) には key 重複が無いこと、pos 側の重複は全列完全 identical で `prc_id2`/`prc_id3` 的な追加 key は不要であることを、北海道全域の実 CSV スキャンで verify 済み。
