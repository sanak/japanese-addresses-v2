# Bench: SQLite vs DuckDB

`mergeDataLeftJoin` の SQLite / DuckDB 実装を 02/03/04 パイプラインで比較する。

## 前提

- `settings-京都府.json` または `settings-北海道.json` をプロジェクトルートに配置
- `npm ci` 済み
- 01_make_prefecture_city は別途実行済み (本ベンチは 02/03/04 のみ計測)

## 使い方

```bash
./scripts/bench/run_bench.sh 京都府 sqlite
./scripts/bench/run_bench.sh 京都府 duckdb
./scripts/bench/run_bench.sh 北海道 sqlite
./scripts/bench/run_bench.sh 北海道 duckdb
```

各 3 反復走らせて中央値を `docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md` に記録する。

## 出力

`bench-results/<pref>-<backend>-<stamp>/` 配下に:

- `*.time`: `/usr/bin/time -l` の rusage 出力 (wall time, peak RSS 等)
- `*.log`: 各ステップの stdout/stderr
- `out-snapshot.tar`: `out/api/` のスナップショット
- `checksums.sha256`: byte 一致比較用ハッシュ
