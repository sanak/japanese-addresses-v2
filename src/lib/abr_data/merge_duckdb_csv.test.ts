import assert from 'node:assert';
import test, { describe } from 'node:test';

import { buildLgCodeWhereClause } from './merge_duckdb_csv.js';

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
