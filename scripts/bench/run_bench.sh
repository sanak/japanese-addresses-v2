#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <京都府|北海道> <sqlite|duckdb>" >&2
  exit 1
fi

PREF="$1"
BACKEND="$2"

if [[ "$BACKEND" != "sqlite" && "$BACKEND" != "duckdb" ]]; then
  echo "BACKEND must be 'sqlite' or 'duckdb'" >&2
  exit 1
fi

SETTINGS_FILE="settings-${PREF}.json"
if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "settings file not found: $SETTINGS_FILE" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
OUTDIR="bench-results/${PREF}-${BACKEND}-${STAMP}"
mkdir -p "$OUTDIR"

export SETTINGS_JSON="$(cat "$SETTINGS_FILE")"
export MERGE_BACKEND="$BACKEND"

if [[ -d out ]]; then
  mv out "out.bak-${STAMP}"
fi

for step in 02_make_machi_aza 03_make_rsdt 04_make_chiban; do
  echo "=== Running $step (backend=$BACKEND, pref=$PREF) ==="
  /usr/bin/time -l -o "$OUTDIR/${step}.time" \
    npm run "run:${step}" 2>&1 | tee "$OUTDIR/${step}.log"
done

echo "=== Snapshotting output ==="
tar -cf "$OUTDIR/out-snapshot.tar" out/api
find out/api -type f | sort | xargs shasum -a 256 > "$OUTDIR/checksums.sha256"

echo "=== Done. Results: $OUTDIR ==="
