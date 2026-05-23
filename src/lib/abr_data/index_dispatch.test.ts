import assert from 'node:assert';
import test, { describe } from 'node:test';

import { mergeDataLeftJoin } from './index.js';

async function* gen<T>(items: T[]): AsyncIterableIterator<T> {
  for (const it of items) yield it;
}

await describe('mergeDataLeftJoin dispatcher', async () => {
  await test('defaults to sqlite when MERGE_BACKEND is unset', async () => {
    delete process.env.MERGE_BACKEND;
    const res = await Array.fromAsync(mergeDataLeftJoin(
      gen([{ id: 1, a: 'x' }]),
      gen([{ id: 1, b: 'y' }]),
      ['id'],
    ));
    assert.deepStrictEqual(res, [{ id: 1, a: 'x', b: 'y' }]);
  });

  await test('uses duckdb when MERGE_BACKEND=duckdb', async () => {
    process.env.MERGE_BACKEND = 'duckdb';
    try {
      const res = await Array.fromAsync(mergeDataLeftJoin(
        gen([{ id: 1, a: 'x' }]),
        gen([{ id: 1, b: 'y' }]),
        ['id'],
      ));
      assert.deepStrictEqual(res, [{ id: 1, a: 'x', b: 'y' }]);
    } finally {
      delete process.env.MERGE_BACKEND;
    }
  });

  await test('falls back to sqlite for unknown MERGE_BACKEND', async () => {
    process.env.MERGE_BACKEND = 'unknown';
    try {
      const res = await Array.fromAsync(mergeDataLeftJoin(
        gen([{ id: 1, a: 'x' }]),
        gen([{ id: 1, b: 'y' }]),
        ['id'],
      ));
      assert.deepStrictEqual(res, [{ id: 1, a: 'x', b: 'y' }]);
    } finally {
      delete process.env.MERGE_BACKEND;
    }
  });
});
