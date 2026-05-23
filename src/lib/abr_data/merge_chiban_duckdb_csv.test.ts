import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import type { HubSearchResult } from '../hub.js';
import {
  createChibanDuckdbCtx,
  closeChibanDuckdbCtx,
  mergeChibanDataDuckdbCsv,
  type ChibanDuckdbCtx,
  type ChibanDuckdbLifecycle,
} from './merge_chiban_duckdb_csv.js';

const FIXTURE_ROOT = path.join(
  import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'lib', 'abr_data', 'merge_chiban_duckdb_csv',
);

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

/**
 * CACHE_DIR を tmp に差し替え、Hub URL → fixture ZIP の cache 配置を行う。
 * fetch には到達しないので、ネットワーク無しでテスト可能。
 */
async function withCachedZipFixture<T>(
  zips: { url: string; fixturePath: string }[],
  fn: () => Promise<T>,
): Promise<T> {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chiban-cache-'));
  const prevCacheDir = process.env.CACHE_DIR;
  process.env.CACHE_DIR = cacheRoot;
  try {
    await fs.mkdir(path.join(cacheRoot, 'files'), { recursive: true });
    for (const { url, fixturePath } of zips) {
      const cacheKey = url.replace(/[^a-zA-Z0-9]/g, '_');
      await fs.copyFile(fixturePath, path.join(cacheRoot, 'files', cacheKey));
    }
    return await fn();
  } finally {
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
}

function makeHubResult(url: string, _lg_code: string): HubSearchResult {
  return {
    type: 'Feature',
    geometry: null,
    properties: { id: `stub-${_lg_code}`, title: `stub-${_lg_code}`, url },
  } as unknown as HubSearchResult;
}

async function withCtx<T>(
  lifecycle: ChibanDuckdbLifecycle,
  fn: (ctx: ChibanDuckdbCtx) => Promise<T>,
): Promise<T> {
  const ctx = await createChibanDuckdbCtx(lifecycle);
  try { return await fn(ctx); } finally { await closeChibanDuckdbCtx(ctx); }
}

await describe('mergeChibanDataDuckdbCsv (percity)', async () => {
  await test('basic LEFT JOIN with pos: 3 main + 2 pos, miss row has rep_lat=null', async () => {
    const mainUrl = 'https://example.test/011002_csv_zip';
    const posUrl  = 'https://example.test/011002_pos_csv_zip';
    const rows = await withCachedZipFixture(
      [
        { url: mainUrl, fixturePath: path.join(FIXTURE_ROOT, 'main.zip') },
        { url: posUrl,  fixturePath: path.join(FIXTURE_ROOT, 'pos.zip') },
      ],
      async () => withCtx('percity', async (ctx) => Array.fromAsync(
        mergeChibanDataDuckdbCsv(
          makeHubResult(mainUrl, '011002'),
          makeHubResult(posUrl,  '011002'),
          ctx,
        ),
      )),
    );
    assert.strictEqual(rows.length, 3);
    const hit = rows.find((r) => (r as { prc_id?: string }).prc_id === '0001');
    assert.strictEqual((hit as { rep_lat?: string | null })?.rep_lat, '43.06');
    const miss = rows.find((r) => (r as { prc_id?: string }).prc_id === '0003');
    assert.strictEqual((miss as { rep_lat?: string | null })?.rep_lat, null);
  });

  await test('no-pos city: all main rows yield with rep_lat=null', async () => {
    const mainUrl = 'https://example.test/131059_csv_zip';
    const rows = await withCachedZipFixture(
      [{ url: mainUrl, fixturePath: path.join(FIXTURE_ROOT, 'main-nopos.zip') }],
      async () => withCtx('percity', async (ctx) => Array.fromAsync(
        mergeChibanDataDuckdbCsv(
          makeHubResult(mainUrl, '131059'),
          undefined,
          ctx,
        ),
      )),
    );
    assert.strictEqual(rows.length, 2);
    for (const r of rows) {
      assert.strictEqual((r as { rep_lat?: string | null }).rep_lat, null);
      assert.strictEqual((r as { rep_lon?: string | null }).rep_lon, null);
    }
  });

  await test('ORDER BY (lg_code, machiaza_id, prc_id) is stable across runs', async () => {
    const mainUrl = 'https://example.test/011002_csv_zip';
    const posUrl  = 'https://example.test/011002_pos_csv_zip';
    const run = () => withCachedZipFixture(
      [
        { url: mainUrl, fixturePath: path.join(FIXTURE_ROOT, 'main.zip') },
        { url: posUrl,  fixturePath: path.join(FIXTURE_ROOT, 'pos.zip') },
      ],
      async () => withCtx('percity', async (ctx) => Array.fromAsync(
        mergeChibanDataDuckdbCsv(
          makeHubResult(mainUrl, '011002'),
          makeHubResult(posUrl,  '011002'),
          ctx,
        ),
      )),
    );
    const a = await run();
    const b = await run();
    const keysA = a.map((r) => `${(r as { lg_code: string }).lg_code}|${(r as { machiaza_id: string }).machiaza_id}|${(r as { prc_id: string }).prc_id}`);
    const keysB = b.map((r) => `${(r as { lg_code: string }).lg_code}|${(r as { machiaza_id: string }).machiaza_id}|${(r as { prc_id: string }).prc_id}`);
    assert.deepStrictEqual(keysA, keysB);
    assert.deepStrictEqual(keysA, ['011002|0001000|0001', '011002|0001000|0002', '011002|0001000|0003']);
  });

  await test('throws on lg_code derived from URL not matching /^[0-9]+$/', async () => {
    // 設計書 §5 の lg_code validate。HubSearchResult 経由なので、
    // 実装内で URL からの lg_code 抽出に失敗するケースは別途扱う。
    // ここでは URL に lg_code 数字が含まれない fixture で throw を確認。
    const badUrl = 'https://example.test/no-lg-code-here.zip';
    await assert.rejects(
      async () => withCachedZipFixture(
        [{ url: badUrl, fixturePath: path.join(FIXTURE_ROOT, 'main.zip') }],
        async () => withCtx('percity', async (ctx) => Array.fromAsync(
          mergeChibanDataDuckdbCsv(makeHubResult(badUrl, 'xxx'), undefined, ctx),
        )),
      ),
      /lg_code/,
    );
  });

  await test('cleans up city-<lg_code>/db-<lg_code> after iteration ends', async () => {
    const mainUrl = 'https://example.test/011002_csv_zip';
    const posUrl  = 'https://example.test/011002_pos_csv_zip';
    await withCachedZipFixture(
      [
        { url: mainUrl, fixturePath: path.join(FIXTURE_ROOT, 'main.zip') },
        { url: posUrl,  fixturePath: path.join(FIXTURE_ROOT, 'pos.zip') },
      ],
      async () => withCtx('percity', async (ctx) => {
        // 1 行受け取って break — generator の finally が走ることを期待
        const iter = mergeChibanDataDuckdbCsv(
          makeHubResult(mainUrl, '011002'),
          makeHubResult(posUrl,  '011002'),
          ctx,
        );
        for await (const _ of iter) { void _; break; }
        // db-011002/ が削除されていること
        const entries = await fs.readdir(ctx.tempRoot);
        const remaining = entries.filter((n) => n.startsWith('db-011002'));
        assert.deepStrictEqual(remaining, []);
      }),
    );
  });
});
