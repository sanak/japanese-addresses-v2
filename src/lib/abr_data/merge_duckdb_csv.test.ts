import assert from 'node:assert';
import test, { describe } from 'node:test';
import path from 'node:path';

import { buildLgCodeWhereClause, mergeJoinFromCsvDirs } from './merge_duckdb_csv.js';

const FIXTURE_ROOT = path.join(
  import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'lib', 'abr_data', 'merge_duckdb_csv',
);

await describe('buildLgCodeWhereClause', async () => {
  await test('returns undefined for empty patterns', () => {
    assert.strictEqual(buildLgCodeWhereClause('l.lg_code', []), undefined);
  });

  await test('returns single regexp_matches for one pattern', () => {
    assert.strictEqual(
      buildLgCodeWhereClause('l.lg_code', [/^01/]),
      "regexp_matches(l.lg_code, '^01')",
    );
  });

  await test('joins multiple patterns with OR', () => {
    assert.strictEqual(
      buildLgCodeWhereClause('l.lg_code', [/^01/, /^13/]),
      "regexp_matches(l.lg_code, '^01') OR regexp_matches(l.lg_code, '^13')",
    );
  });

  await test('escapes single quotes in pattern source', () => {
    assert.strictEqual(
      buildLgCodeWhereClause('l.lg_code', [/o'malley/]),
      "regexp_matches(l.lg_code, 'o''malley')",
    );
  });
});

await describe('mergeJoinFromCsvDirs', async () => {
  await test('LEFT JOIN yields all main rows, with null for missing pos', async () => {
    const rows = await Array.fromAsync(mergeJoinFromCsvDirs({
      mainDir: path.join(FIXTURE_ROOT, 'main'),
      posDir:  path.join(FIXTURE_ROOT, 'pos'),
      lgCodePatterns: [],
    }));
    assert.strictEqual(rows.length, 4);
    const hit = rows.find((r) => r.lg_code === '011002' && r.rsdt_id === '001');
    assert.strictEqual(hit?.rep_lat, '43.0');
    const miss = rows.find((r) => r.lg_code === '011002' && r.machiaza_id === '0002000');
    assert.strictEqual(miss?.rep_lat, null);
  });

  await test('overrides override-columns from pos when pos is non-null (COALESCE semantics)', async () => {
    const rows = await Array.fromAsync(mergeJoinFromCsvDirs({
      mainDir: path.join(FIXTURE_ROOT, 'main'),
      posDir:  path.join(FIXTURE_ROOT, 'pos'),
      lgCodePatterns: [],
    }));
    const hit = rows.find((r) => r.lg_code === '011002' && r.rsdt_id === '001');
    assert.strictEqual(hit?.rsdt_addr_flg, '9');
    assert.strictEqual(hit?.rsdt_addr_mtd_code, '9');
    assert.strictEqual(hit?.basic_rsdt_div, '9');
    const miss = rows.find((r) => r.lg_code === '011002' && r.machiaza_id === '0002000');
    assert.strictEqual(miss?.rsdt_addr_flg, '1');
    assert.strictEqual(miss?.basic_rsdt_div, '1');
  });

  await test('pushes lgCode WHERE down — pref01 only', async () => {
    const rows = await Array.fromAsync(mergeJoinFromCsvDirs({
      mainDir: path.join(FIXTURE_ROOT, 'main'),
      posDir:  path.join(FIXTURE_ROOT, 'pos'),
      lgCodePatterns: [/^01/],
    }));
    assert.strictEqual(rows.length, 3);
    assert.ok(rows.every((r) => r.lg_code !== null && r.lg_code.startsWith('01')));
  });

  await test('orders by full merge key (lg_code, machiaza_id, blk_id, rsdt_id, rsdt2_id)', async () => {
    const rows = await Array.fromAsync(mergeJoinFromCsvDirs({
      mainDir: path.join(FIXTURE_ROOT, 'main'),
      posDir:  path.join(FIXTURE_ROOT, 'pos'),
      lgCodePatterns: [],
    }));
    const keys = rows.map((r) =>
      [r.lg_code, r.machiaza_id, r.blk_id, r.rsdt_id, r.rsdt2_id].join('|'),
    );
    const sorted = [...keys].sort();
    assert.deepStrictEqual(keys, sorted);
  });
});
