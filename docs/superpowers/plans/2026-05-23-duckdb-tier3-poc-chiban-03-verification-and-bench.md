# DuckDB Tier 3 PoC for 04_make_chiban — Phase 3: Verification & Benchmark

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1/2 で実装した `MERGE_BACKEND=duckdb-csv` 経路 (per-city / shared 両モード) を、実 ABR データで Map fast-path との **byte-exact 同一性** で検証し、京都府 + 北海道で 3 backend (baseline / duckdb-csv-percity / duckdb-csv-shared) のベンチマークを取って、設計書 §6.3 の判定基準で PoC の合否を `docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md` に記録する。

**Architecture:** 検証は `out/api/` を `diff -r` で比較する古典的手法。ベンチマークは `/usr/bin/time -l` で wall time / peak RSS を計測し、3 backend × 2 県 = 6 ランを順次実行。出力 snapshot を `bench-results/04-<pref>-<backend>-<TS>/` に保存して再検証可能にする。最終的に `bench-results.md` の末尾に「Tier 3 PoC for 04_make_chiban」セクションを追記して、(a) lifecycle 選定の推奨 (b) Map 比昇格判断 の 2 軸結果を残す。

**Tech Stack:** bash, `/usr/bin/time -l`, `diff -r`, `shasum`, npm scripts

**Related spec:** [`docs/superpowers/specs/2026-05-23-duckdb-tier3-poc-chiban-design.md`](../specs/2026-05-23-duckdb-tier3-poc-chiban-design.md)

**Phase 1 (prerequisite):** [`2026-05-23-duckdb-tier3-poc-chiban-01-foundation.md`](./2026-05-23-duckdb-tier3-poc-chiban-01-foundation.md)
**Phase 2 (prerequisite):** [`2026-05-23-duckdb-tier3-poc-chiban-02-shared-and-caller.md`](./2026-05-23-duckdb-tier3-poc-chiban-02-shared-and-caller.md)

---

## Pre-flight

- [ ] **Step 1: Phase 1/2 が完了していることを確認**

```bash
git log --oneline -10
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -5
npm run lint 2>&1 | tail -5
npm run build:dev 2>&1 | tail -5
```

Expected: 直近 7 コミットに Phase 1 の 3 件 (ChibanDataWithPos / ctx skeleton / percity merge) + Phase 2 の 3 件 (shared ctx / shared merge / caller wiring) + 必要なら sweep fix が並ぶ。テストは 14 件 pass、lint / tsc は 0 error。

- [ ] **Step 2: settings ファイルと cache の前提を確認**

```bash
ls settings-京都府.json settings-北海道.json
ls cache/files | grep -c "parcel"
```

Expected: 2 つの settings ファイルが存在し、`cache/files` に parcel 系 cache (main + pos 両方) が ~3720 個程度ある。cache が無い県の初回 baseline 実行時は Hub からネットワーク取得が走るので時間がかかる前提。

- [ ] **Step 3: `out/` を退避する**

既存 `out/` をベンチ前に退避 (PoC で何度も上書きする):

```bash
if [ -d out ]; then mv out out.bak-pre-tier3-04-$(date +%Y%m%d-%H%M%S); fi
mkdir -p out
```

---

## Task 8: 等価性検証 — baseline (Map) vs duckdb-csv-{percity,shared}

**Files:** なし (実行と diff のみ)

設計書 §6.2 の PoC 成立条件を、北海道 (188 自治体、京都府の 5 倍) で verify する。byte-exact 同一が両モードで取れたら次の Task 9 (ベンチ) に進む。差分が出たら原因切り分け表 (本 task Step 4) に従い、修正を Phase 1 or Phase 2 のいずれかの該当タスクに **amend ではなく独立コミット** で当てる。

- [ ] **Step 1: baseline (Map fast-path) で生成**

```bash
rm -rf out/api
SETTINGS_JSON="$(cat settings-北海道.json)" npm run run:04_make_chiban 2>&1 | tail -10
ls out/api/北海道/ | head
mv out/api out-baseline-chiban-tier3
```

Expected: `北海道/<市区町村>-地番.txt` ファイルが 188 件前後生成される (`bench-results.md` の北海道 04 結果と同じ件数)。

- [ ] **Step 2: duckdb-csv percity で生成**

```bash
rm -rf out/api
SETTINGS_JSON="$(cat settings-北海道.json)" \
  MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE=percity \
  npm run run:04_make_chiban 2>&1 | tail -10
ls out/api/北海道/ | head
```

Expected: 同じ件数のファイルが生成される。標準出力の冒頭に `MERGE_BACKEND=duckdb-csv with CHIBAN_DUCKDB_LIFECYCLE=percity` が見える (Task 6 で追加した console.log)。

- [ ] **Step 3: percity の diff を取る**

```bash
diff -r out-baseline-chiban-tier3/北海道 out/api/北海道 | tee /tmp/chiban-tier3-percity.diff
wc -l /tmp/chiban-tier3-percity.diff
```

Expected: **0 行** (完全一致)。

- [ ] **Step 4: 差分が出た場合の切り分け指針 (percity)**

`/tmp/chiban-tier3-percity.diff` の中身に応じて:

| 症状 | 疑うべき箇所 | 修正先 |
|------|-------------|--------|
| 全ファイルでサイズ差 | header chunk size (`HEADER_CHUNK_SIZE`) の整合性、apiData 配列順 | Phase 2 Task 6 の `processCity` ループ |
| 数ファイルだけサイズ差 | LEFT JOIN ミスヒット行の null 判定 (`raw.rep_srid != null`) | Phase 2 Task 6 Step 4 の type predicate |
| サイズは同じだがバイナリ差 | ORDER BY の secondary sort 差 | Phase 1 Task 3 Step 5 の `buildJoinSql` の COALESCE list |
| 北海道で特定の県外 lg_code 行 | settings.lgCodes 想定外の行が混入 | API 内の lg_code validate (Phase 1 Task 3 Step 5) |
| `cityRoot` 由来のテンポラリパス漏れ | finally の rm 漏れ | Phase 2 Task 5 Step 3 の cleanup 分岐 |

修正を入れたら Phase 1 / Phase 2 の該当 plan task の commit に **amend ではなく** 独立コミットで repair commit を作る (CLAUDE.md の git ガイダンス通り)。

- [ ] **Step 5: duckdb-csv shared で生成**

```bash
rm -rf out/api
SETTINGS_JSON="$(cat settings-北海道.json)" \
  MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE=shared \
  npm run run:04_make_chiban 2>&1 | tail -10
ls out/api/北海道/ | head
```

Expected: 同じ件数のファイル生成、冒頭ログに `with CHIBAN_DUCKDB_LIFECYCLE=shared`。

- [ ] **Step 6: shared の diff を取る**

```bash
diff -r out-baseline-chiban-tier3/北海道 out/api/北海道 | tee /tmp/chiban-tier3-shared.diff
wc -l /tmp/chiban-tier3-shared.diff
```

Expected: **0 行** (完全一致)。

- [ ] **Step 7: 差分が出た場合の切り分け指針 (shared)**

shared モード固有の症状を追加で疑う:

| 症状 | 疑うべき箇所 | 修正先 |
|------|-------------|--------|
| 並列 city 間のデータ混入 | TEMP VIEW の connection scope 前提が崩れている | Phase 2 Task 5 Step 3 の `connection = await instanceToUse.connect()` 配置 |
| city 単位の出力欠落 | shared finally で view を消し過ぎ (他 city の view を巻き込んだ等) | Phase 2 Task 5 Step 3 の `DROP VIEW IF EXISTS l_${lg_code}` (lg_code が確実に suffix されているか) |
| DuckDB memory_limit 超過 | shared instance に view が滞留して RAM 圧迫 | `configureDuckdbConnection` の threads / memory_limit 設定 |

- [ ] **Step 8: クリーンアップ**

```bash
rm -rf out-baseline-chiban-tier3
```

検証成果物 (out-baseline-chiban-tier3) はコミット対象外。出力 snapshot は Task 9 のベンチで bench-results/ に格納する。

---

## Task 9: ベンチマーク (京都府 + 北海道 × 3 backends)

**Files:**
- Create: `bench-results/04-京都府-{baseline,duckdb-csv-percity,duckdb-csv-shared}-<TS>/`
- Create: `bench-results/04-北海道-{baseline,duckdb-csv-percity,duckdb-csv-shared}-<TS>/`

設計書 §6.3 のベンチマトリクス。判定 2 軸:

1. **lifecycle 選定**: `shared` vs `percity` で wall time / peak RSS を比較、勝った方を `CHIBAN_DUCKDB_LIFECYCLE` 未指定時のデフォルト推奨として確定 (現在 default は `shared` 仮置き、計測で覆る可能性あり)
2. **Map 比昇格判断**: 勝った lifecycle で Map fast-path 比 wall time -20% 以上 かつ peak RSS 同等以下 を満たせば、別 PR で昇格起案。京都府で届かなくても 03 PoC と同じく workload-size limitation として許容、北海道規模で評価

- [ ] **Step 1: 計測ヘルパー関数を準備**

シェルセッションに以下を貼って関数定義 (スクリプトファイル化は任意):

```bash
run_bench_04() {
  local pref="$1"        # 京都府 / 北海道
  local backend="$2"     # baseline / duckdb-csv-percity / duckdb-csv-shared
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  local outroot="bench-results/04-${pref}-${backend}-${ts}"
  mkdir -p "$outroot"
  rm -rf out/api
  local env_prefix=""
  case "$backend" in
    baseline)             env_prefix="" ;;
    duckdb-csv-percity)   env_prefix="MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE=percity" ;;
    duckdb-csv-shared)    env_prefix="MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE=shared" ;;
  esac
  /usr/bin/time -l env SETTINGS_JSON="$(cat settings-${pref}.json)" $env_prefix \
    npm run run:04_make_chiban \
    > "$outroot/04_make_chiban.log" 2> "$outroot/04_make_chiban.time"
  cp -r out/api "$outroot/out-snapshot"
  ( cd "$outroot/out-snapshot" && find . -type f -exec shasum -a 256 {} \; ) \
    > "$outroot/checksums.sha256"
  echo "Done: $outroot"
}
```

- [ ] **Step 2: 京都府 3 backends を順に計測**

```bash
run_bench_04 京都府 baseline
run_bench_04 京都府 duckdb-csv-percity
run_bench_04 京都府 duckdb-csv-shared
```

各実行で `out/api` をクリアしてから走らせるので相互汚染なし。各 `*.time` ファイルに `/usr/bin/time -l` の real / user / sys / maximum resident set size が入る。

- [ ] **Step 3: 北海道 3 backends を順に計測**

```bash
run_bench_04 北海道 baseline
run_bench_04 北海道 duckdb-csv-percity
run_bench_04 北海道 duckdb-csv-shared
```

各ラン 3-7 分程度 (北海道 baseline は `bench-results.md` 既存値で 177s、duckdb 経路は短縮見込み)。

- [ ] **Step 4: 結果テーブルを抽出**

```bash
for f in bench-results/04-京都府-{baseline,duckdb-csv-percity,duckdb-csv-shared}-*/04_make_chiban.time \
         bench-results/04-北海道-{baseline,duckdb-csv-percity,duckdb-csv-shared}-*/04_make_chiban.time; do
  d="$(dirname "$f")"
  real="$(grep -m1 real "$f" | awk '{print $1}' || true)"
  rss="$(awk '/maximum resident set size/ {print $1}' "$f")"
  printf '%-70s real=%s RSS_bytes=%s\n' "$d" "$real" "$rss"
done
```

Expected: 6 行。`real` は `MM:SS.mm` 形式または秒、`RSS_bytes` をバイト → MB 換算 (1048576 で割る) してメモ。

- [ ] **Step 5: 出力同一性の最終確認 (3 backends 間、京都府)**

Task 8 で北海道は確認済。京都府でも同様の確認を bench snapshot 間で実施:

```bash
diff -r bench-results/04-京都府-baseline-*/out-snapshot/京都府 \
        bench-results/04-京都府-duckdb-csv-percity-*/out-snapshot/京都府 | head -5
diff -r bench-results/04-京都府-baseline-*/out-snapshot/京都府 \
        bench-results/04-京都府-duckdb-csv-shared-*/out-snapshot/京都府 | head -5
```

Expected: いずれも 0 行。

差分が出た場合、Task 8 step 4/7 の切り分け表で再診断。京都府特有の collation 差 (例: `（耕）7-7` の全角括弧) が出る可能性は 03 PoC bench-results.md §「重要な発見 2」と同じ問題なので、本 PoC でも許容可能か bench-results.md §「設計書からの差分」セクションに記載する余地を残す。

- [ ] **Step 6: 数値をメモして Task 10 に渡す**

このベンチマーク結果 (real / RSS / 同一性) を Task 10 で `bench-results.md` に転記する。コミットはまだしない (PoC の前提資料として `bench-results/` ディレクトリは未追跡のまま残す)。

---

## Task 10: PoC 結論と `bench-results.md` 追記

**Files:**
- Modify: `docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md`

PoC の judge と `bench-results.md` への追記。Task 9 の数値で 2 軸判定を行う:

1. **lifecycle 選定**: `shared` vs `percity` の数値で勝者を確定し、設計書 §2 の判断要旨表の `CHIBAN_DUCKDB_LIFECYCLE` 行 (現在「PoC で計測して推奨を決定」) を確定値で更新する
2. **昇格判断**: 勝った lifecycle で Map fast-path 比 wall time -20% 以上 / RSS 同等以下を満たすか

- [ ] **Step 1: 既存 doc の末尾を確認**

```bash
wc -l docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md
tail -10 docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md
```

Expected: 212 行程度 (03 PoC 追記後の状態)。末尾は「workload-size limitation」段落のはず。

- [ ] **Step 2: Tier 3 PoC for 04_make_chiban セクションを末尾に追記**

`docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md` の末尾 (現状の line 212 以降) に追記:

````markdown

## Tier 3 PoC (duckdb-csv) for 04_make_chiban 追計測

- 追計測日: <YYYY-MM-DD>
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
| 京都府   | <X>            | <Y>                | <Z>                 | **<ΔPp %>**         | **<ΔPs %>**         |
| 北海道   | <X>            | <Y>                | <Z>                 | **<ΔPp %>**         | **<ΔPs %>**         |

### peak RSS (MB) — 04_make_chiban のみ

| 都道府県 | baseline (Map) | duckdb-csv-percity | duckdb-csv-shared | percity の対 Map 比 (MB) | shared の対 Map 比 (MB) |
|---------|----------------|--------------------|---------------------|--------------------------|--------------------------|
| 京都府   | <X>            | <Y>                | <Z>                 | <ΔMp>                    | <ΔMs>                    |
| 北海道   | <X>            | <Y>                | <Z>                 | <ΔMp>                    | <ΔMs>                    |

### 出力同一性 (baseline vs duckdb-csv-*)

- 京都府 percity: **<完全一致 / 差分あり>** (差分件数 <n>/<total>)
- 京都府 shared:  **<完全一致 / 差分あり>** (差分件数 <n>/<total>)
- 北海道 percity: **<完全一致 / 差分あり>** (差分件数 <n>/<total>)
- 北海道 shared:  **<完全一致 / 差分あり>** (差分件数 <n>/<total>)

### lifecycle 選定 (PoC 判定軸 1)

判定基準: `shared` vs `percity` を直接比較し、wall time が短い側を「`CHIBAN_DUCKDB_LIFECYCLE` 未指定時のデフォルト推奨」として確定する。RSS が大幅劣化 (例: +50% 以上) する側は不採用候補。

- 京都府: **<shared 推奨 / percity 推奨 / 同等>** (wall 差 <Δ %>, RSS 差 <Δ MB>)
- 北海道: **<shared 推奨 / percity 推奨 / 同等>** (wall 差 <Δ %>, RSS 差 <Δ MB>)

→ 設計書 §2 の `CHIBAN_DUCKDB_LIFECYCLE` 行を **<確定したデフォルト値>** に更新する別コミットを起案。

### Map 比昇格判断 (PoC 判定軸 2)

判定基準: 勝った lifecycle で baseline (Map fast-path) 比 **wall time -20% 以上 かつ peak RSS 同等以下**

- 京都府: **<合格 / 不合格>** (勝った lifecycle: <X>, wall <Δ %>, RSS <Δ MB>)
- 北海道: **<合格 / 不合格>** (勝った lifecycle: <X>, wall <Δ %>, RSS <Δ MB>)

### 所感と次のアクション

<北海道合格の場合>
- `MERGE_BACKEND=duckdb-csv` + 確定 `CHIBAN_DUCKDB_LIFECYCLE` を 04 のデフォルトに昇格する PR を別タスクで起案
- 02 (machi_aza) への Tier 3 横展開も検討
- 03 と 04 の重複コード (DuckDB セッション初期化 / view 命名 / temp 管理) の汎用化リファクタは昇格 PR と切り離して別タスク

<北海道不合格の場合>
- ボトルネック特定: `DEBUG_DUCKDB=1` 相当の手動 `EXPLAIN ANALYZE` で scan / join / sort のどこで時間を消費しているか調査
- per-city DuckDB instance 起動コスト (~1887 回) が支配的なら、中間モード「自治体 N 件で 1 instance」を Task 10 後の別 PoC で評価
- caller 側 `CHIBAN_CONCURRENCY` を変えた場合の影響を別途計測

### 設計書からの差分 (もしあれば)

PoC 実装中に設計書 §X が見落としていた点があればここに追記。例: 03 PoC で `IS NOT DISTINCT FROM` への変更が必要だったように、04 PoC でも実装中に判明した spec gap を記録する。
````

`<X>` `<Y>` `<Z>` `<ΔPp %>` 等は Task 9 step 4 で抽出した数値で埋める。`<合格 / 不合格>` `<shared 推奨 / percity 推奨 / 同等>` は判定の結論を選んで残す。

- [ ] **Step 3: markdown 表示確認**

```bash
sed -n '213,$p' docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md | head -80
wc -l docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md
```

Expected: 末尾に追記された Tier 3 PoC for 04 セクションが見えること。

- [ ] **Step 4: コミット**

PoC 成否に応じてコミットメッセージを変える (成否ラベルはコミットメッセージに入れない。doc 内の判定セクションに書く。03 と同じスタイル):

```bash
git add docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md
git commit -m "Record DuckDB Tier 3 PoC bench results for 04_make_chiban"
```

- [ ] **Step 5: 設計書 §2 判断要旨表の確定 (lifecycle 選定の結果反映)**

Task 9 で確定した `CHIBAN_DUCKDB_LIFECYCLE` のデフォルト値を、設計書 `docs/superpowers/specs/2026-05-23-duckdb-tier3-poc-chiban-design.md` §2 の表に反映する。現状:

```
| DuckDB ライフサイクル | **`shared` と `percity` の 2 モードを両方実装、PoC で計測して推奨を決定** | per-city は ... |
```

を計測結果に応じて以下のいずれかに更新:

```
| DuckDB ライフサイクル | **`<確定モード>` をデフォルト推奨、もう一方は env で opt-in** | PoC 実測 (bench-results.md §Tier 3 PoC for 04) で <確定モード> が wall <Δ%> 優位 |
```

- [ ] **Step 6: 設計書更新をコミット**

```bash
git add docs/superpowers/specs/2026-05-23-duckdb-tier3-poc-chiban-design.md
git commit -m "Pin CHIBAN_DUCKDB_LIFECYCLE default based on PoC bench results"
```

---

## Self-Review チェックリスト (Phase 3)

実装完了直後に以下を眼で確認:

1. **Spec coverage (Phase 3 範囲)**: 設計書 §6.2 等価性検証 (Task 8)、§6.3 ベンチマーク 2 軸 (Task 9 + Task 10)、§6.3 末尾の bench-results.md 追記 (Task 10) が全て完了していること。
2. **Placeholder scan**: plan 全文に「TBD」「TODO」「あとで」「実装してください」が無いか確認 (Task 10 Step 2 の `<YYYY-MM-DD>` 等の **記入欄プレースホルダ** は意図的なものなので OK)。
3. **数値の一貫性**: bench-results.md の表に書いた数値が `bench-results/04-*/04_make_chiban.time` の raw 値と一致 (転記ミスがないこと)。RSS は bytes → MB の換算 (÷ 1048576) を間違えていないこと。
4. **既存 bench-results.md の整合**: 末尾追加なので既存セクション (03 PoC の Tier 3 結果) は触らない。元ファイルの marker 「Tier 3 PoC (duckdb-csv) 追計測」(03 用) と本 PoC の「Tier 3 PoC (duckdb-csv) for 04_make_chiban 追計測」が同居しているはず。
5. **設計書 §2 の更新**: Task 10 Step 5 の更新で `CHIBAN_DUCKDB_LIFECYCLE` 行が確定値になっていること。両モード並存の余地は残しつつ「デフォルト推奨」を明示。
6. **bench-results/ の扱い**: `bench-results/` ディレクトリは git status の未追跡のまま残してよい (03 PoC と同じ慣習)。コミットされるのは doc 更新だけ。

---

## Execution Handoff (全 Phase 完了時)

全 3 Phase の完了状態:

- Phase 1: per-city モード実装、`merge_chiban_duckdb_csv.test.ts` 緑
- Phase 2: shared モード追加 + caller 配線、全テスト緑
- Phase 3: 北海道で byte-exact 等価性確認、ベンチで 2 軸判定、bench-results.md / 設計書 §2 更新

ここから先のアクション:

- **昇格 PR** (北海道で Map 比 -20% 以上 合格の場合): `MERGE_BACKEND=duckdb-csv` を 04 のデフォルトに昇格する別 PR を起案。`mergeDataLeftJoin(..., true)` Map fast-path 経路は削除、または env で fallback として残す
- **横展開** (02 への Tier 3 適用): 02_make_machi_aza にも同じパターンを適用するか別タスクで設計
- **汎用化リファクタ** (03 と 04 の共通化): `merge_duckdb_csv_common.ts` への抽出を別タスクで設計

これらは全て本 PoC の範囲外。本 PoC は「Tier 3 を 04 にも適用できるか」の合否判定までを成果物として完結する。
