import assert from 'node:assert';
import test, { describe } from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import {
  buildLgCodeWhereClause,
  mergeJoinFromCsvDirs,
  mergeRsdtdspRsdtDataDuckdbCsv,
} from './merge_duckdb_csv.js';
import type { HubSearchResult } from '../hub.js';

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

async function withCachedZipFixture<T>(
  zips: { url: string; fixturePath: string }[],
  fn: () => Promise<T>,
): Promise<T> {
  const cacheRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'mergeRsdtdspDuckdbCsv-cache-'),
  );
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

function makeHubResult(url: string): HubSearchResult {
  return {
    type: 'Feature',
    geometry: null,
    properties: { id: 'stub', title: 'stub', url },
  } as unknown as HubSearchResult;
}

await describe('mergeRsdtdspRsdtDataDuckdbCsv', async () => {
  await test('joins main and pos via Hub URLs, yields RsdtdspRsdtDataWithPos shape', async () => {
    const mainUrl = 'https://example.test/main.zip';
    const posUrl  = 'https://example.test/pos.zip';
    const rows = await withCachedZipFixture(
      [
        { url: mainUrl, fixturePath: path.join(FIXTURE_ROOT, 'main.zip') },
        { url: posUrl,  fixturePath: path.join(FIXTURE_ROOT, 'pos.zip') },
      ],
      async () => Array.fromAsync(
        mergeRsdtdspRsdtDataDuckdbCsv(
          [makeHubResult(mainUrl)],
          [makeHubResult(posUrl)],
        ),
      ),
    );
    assert.strictEqual(rows.length, 4);
    const hit = rows.find((r) => r.lg_code === '011002' && r.rsdt_id === '001');
    assert.strictEqual(hit?.rsdt_addr_flg, '9');
    assert.strictEqual((hit as { rep_lat?: string | null })?.rep_lat, '43.0');
  });

  await test('cleans up temp dir even when consumer breaks early', async () => {
    const mainUrl = 'https://example.test/main2.zip';
    const posUrl  = 'https://example.test/pos2.zip';
    const tmpBefore = await fs.readdir(os.tmpdir());
    const merged = await withCachedZipFixture(
      [
        { url: mainUrl, fixturePath: path.join(FIXTURE_ROOT, 'main.zip') },
        { url: posUrl,  fixturePath: path.join(FIXTURE_ROOT, 'pos.zip') },
      ],
      async () => {
        const iter = mergeRsdtdspRsdtDataDuckdbCsv(
          [makeHubResult(mainUrl)],
          [makeHubResult(posUrl)],
        );
        for await (const _ of iter) { void _; break; }
        return true;
      },
    );
    assert.strictEqual(merged, true);
    const tmpAfter = await fs.readdir(os.tmpdir());
    const stragglers = tmpAfter
      .filter((n) => n.startsWith('merge-rsdt-duckdb-csv-') || n.startsWith('merge-duckdb-csv-'))
      .filter((n) => !tmpBefore.includes(n));
    assert.deepStrictEqual(stragglers, []);
  });
});
