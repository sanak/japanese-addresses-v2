import assert from 'node:assert';
import fs from 'node:fs/promises';
import test, { describe } from 'node:test';

import {
  createChibanDuckdbCtx,
  closeChibanDuckdbCtx,
} from './merge_chiban_duckdb_csv.js';

await describe('createChibanDuckdbCtx (percity)', async () => {
  await test('returns ctx with lifecycle=percity, instance=undefined, fresh tempRoot', async () => {
    const ctx = await createChibanDuckdbCtx('percity');
    try {
      assert.strictEqual(ctx.lifecycle, 'percity');
      assert.strictEqual(ctx.instance, undefined);
      const stat = await fs.stat(ctx.tempRoot);
      assert.ok(stat.isDirectory());
    } finally {
      await closeChibanDuckdbCtx(ctx);
    }
  });

  await test('throws on unknown lifecycle value', async () => {
    await assert.rejects(
      // @ts-expect-error intentionally pass invalid value to verify runtime guard
      () => createChibanDuckdbCtx('invalid'),
      /lifecycle/,
    );
  });

  await test('rejects shared lifecycle in Phase 1 (not yet implemented)', async () => {
    await assert.rejects(
      () => createChibanDuckdbCtx('shared'),
      /shared.*not.*implemented|Phase 2/i,
    );
  });
});

await describe('closeChibanDuckdbCtx (percity)', async () => {
  await test('removes tempRoot recursively', async () => {
    const ctx = await createChibanDuckdbCtx('percity');
    const tempRoot = ctx.tempRoot;
    await closeChibanDuckdbCtx(ctx);
    await assert.rejects(() => fs.stat(tempRoot), /ENOENT/);
  });

  await test('is idempotent (second close does not throw)', async () => {
    const ctx = await createChibanDuckdbCtx('percity');
    await closeChibanDuckdbCtx(ctx);
    await closeChibanDuckdbCtx(ctx); // should not throw
  });
});
