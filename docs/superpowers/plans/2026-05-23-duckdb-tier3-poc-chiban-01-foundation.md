# DuckDB Tier 3 PoC for 04_make_chiban — Phase 1: Foundation (per-city lifecycle)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `04_make_chiban` の duckdb-csv 経路を導入するための基盤を作る。Phase 1 では型定義、ctx ライフサイクル骨格 (percity 限定)、`mergeChibanDataDuckdbCsv` 公開 API の per-city モード実装、および単体テストを完成させる。

**Architecture:** 新規ファイル `src/lib/abr_data/merge_chiban_duckdb_csv.ts` に per-city DuckDB instance を生成・破棄するライフサイクル管理関数 (`createChibanDuckdbCtx` / `closeChibanDuckdbCtx`) と、Hub 検索結果 → temp 展開 → DuckDB LEFT JOIN → ストリーム yield を実装する `mergeChibanDataDuckdbCsv` を追加。Phase 1 時点では `lifecycle='percity'` のみサポートし、`shared` は throw する。既存 `04_make_chiban.ts` の caller は変更しない (Phase 2 で配線)。

**Tech Stack:** TypeScript, Node.js 22, `@duckdb/node-api` ^1.5.3, `unzipper` (既存), `node:test` + `node:assert`, `tsx`

**Related spec:** [`docs/superpowers/specs/2026-05-23-duckdb-tier3-poc-chiban-design.md`](../specs/2026-05-23-duckdb-tier3-poc-chiban-design.md)

**Phase 2:** [`2026-05-23-duckdb-tier3-poc-chiban-02-shared-and-caller.md`](./2026-05-23-duckdb-tier3-poc-chiban-02-shared-and-caller.md)

---

## Pre-flight

- [ ] **Step 1: ブランチを確認する**

派生元・作業ブランチとも `duckdb-tier3-poc-rsdt` (= 03 の PoC ブランチを継続)。

```bash
git status
git branch --show-current
```

Expected: `duckdb-tier3-poc-rsdt` 上にいて、未追跡 `out*/` `cache*/` 以外に dirty ファイルが無い。設計書 `docs/superpowers/specs/2026-05-23-duckdb-tier3-poc-chiban-design.md` は既にコミット済み。

- [ ] **Step 2: 依存と環境の確認**

```bash
node --version    # Expected: v22.x
cat .tool-versions
npm ls @duckdb/node-api unzipper csv-parse
```

Expected: `@duckdb/node-api@1.5.3-r.1` 以上、`unzipper`/`csv-parse` も解決される。

- [ ] **Step 3: ベースライン健全性チェック**

```bash
npm run lint
npm run build:dev
npm run test 2>&1 | tail -20
```

Expected: lint pass / tsc pass / 既存テスト全 pass (failed 件数 0)。03 PoC の `merge_duckdb_csv.test.ts` も含めて緑であることが前提。

---

## Task 1: `ChibanDataWithPos` 型を `chiban.ts` に追加

**Files:**
- Modify: `src/lib/abr_data/chiban.ts`

設計書 §3 で新 API が返す型 `AsyncIterableIterator<ChibanDataWithPos>` を定義するため、`ChibanData | ChibanData & ChibanPosData` を既存 `chiban.ts` の末尾に export する。03 の `RsdtdspRsdtDataWithPos` と同じパターン。

- [ ] **Step 1: 既存 `chiban.ts` の末尾を確認**

```bash
tail -5 src/lib/abr_data/chiban.ts
```

Expected: 84 行目の `};` (ChibanPosData の閉じ括弧) で終わっている。

- [ ] **Step 2: 型を追記する**

`src/lib/abr_data/chiban.ts` の末尾 (line 84 の `};` の直後) に以下を追加:

```ts

export type ChibanDataWithPos = ChibanData | ChibanData & ChibanPosData;
```

- [ ] **Step 3: lint と build 確認**

```bash
npm run lint -- --max-warnings 0 src/lib/abr_data/chiban.ts
npm run build:dev
```

Expected: 0 error / 0 warning。

- [ ] **Step 4: コミット**

```bash
git add src/lib/abr_data/chiban.ts
git commit -m "Add ChibanDataWithPos type export for DuckDB Tier 3 chiban PoC"
```

---

## Task 2: `createChibanDuckdbCtx` / `closeChibanDuckdbCtx` の骨格 (percity 限定)

**Files:**
- Create: `src/lib/abr_data/merge_chiban_duckdb_csv.ts`
- Create: `src/lib/abr_data/merge_chiban_duckdb_csv.test.ts`

設計書 §3 の `ChibanDuckdbCtx` / `createChibanDuckdbCtx` / `closeChibanDuckdbCtx` を percity 限定で実装する。`lifecycle='shared'` は Phase 2 で実装するので Phase 1 では throw する。型シグネチャだけ先に決めて、後続タスク・後続フェーズの依存先を確定させる目的。

- [ ] **Step 1: 失敗テストを書く**

`src/lib/abr_data/merge_chiban_duckdb_csv.test.ts` を新規作成:

```ts
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
```

- [ ] **Step 2: テスト失敗を確認**

```bash
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -20
```

Expected: `Cannot find module './merge_chiban_duckdb_csv.js'` で 5 件 fail。

- [ ] **Step 3: モジュール本体を実装する**

`src/lib/abr_data/merge_chiban_duckdb_csv.ts` を新規作成:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ChibanDuckdbLifecycle = 'shared' | 'percity';

export interface ChibanDuckdbCtx {
  lifecycle: ChibanDuckdbLifecycle;
  instance?: DuckDBInstance;
  tempRoot: string;
}

/**
 * 04_make_chiban の main() 先頭で 1 度呼ぶ。lifecycle に応じ instance を生成または空 ctx を返す。
 * Phase 1: percity のみサポート。shared は Phase 2 で実装。
 */
export async function createChibanDuckdbCtx(
  lifecycle: ChibanDuckdbLifecycle,
): Promise<ChibanDuckdbCtx> {
  if (lifecycle !== 'shared' && lifecycle !== 'percity') {
    throw new Error(
      `createChibanDuckdbCtx: unknown lifecycle "${String(lifecycle)}", expected 'shared' | 'percity'`,
    );
  }
  if (lifecycle === 'shared') {
    throw new Error(
      `createChibanDuckdbCtx: shared lifecycle is not yet implemented (Phase 2)`,
    );
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chiban-duckdb-csv-'));
  return { lifecycle, instance: undefined, tempRoot };
}

/**
 * 04_make_chiban の main() 末尾で 1 度呼ぶ。instance を close し tempRoot を recursive 削除。
 * 同じ ctx に対して複数回呼ばれても (rm が ENOENT を投げないので) 安全。
 */
export async function closeChibanDuckdbCtx(ctx: ChibanDuckdbCtx): Promise<void> {
  if (ctx.instance) {
    try { ctx.instance.closeSync(); } catch { /* ignore */ }
    ctx.instance = undefined;
  }
  await fs.rm(ctx.tempRoot, { recursive: true, force: true }).catch((e: unknown) => {
    console.warn(`closeChibanDuckdbCtx: tempRoot cleanup failed: ${ctx.tempRoot}`, e);
  });
}
```

- [ ] **Step 4: テスト pass を確認**

```bash
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -20
```

Expected: 5 件全 pass。

- [ ] **Step 5: lint と build**

```bash
npm run lint -- --max-warnings 0 src/lib/abr_data/merge_chiban_duckdb_csv.ts src/lib/abr_data/merge_chiban_duckdb_csv.test.ts
npm run build:dev
```

Expected: 0 error / 0 warning。

- [ ] **Step 6: コミット**

```bash
git add src/lib/abr_data/merge_chiban_duckdb_csv.ts src/lib/abr_data/merge_chiban_duckdb_csv.test.ts
git commit -m "Add ChibanDuckdbCtx lifecycle skeleton (percity only)"
```

---

## Task 3: `mergeChibanDataDuckdbCsv` 公開 API (per-city モード) を実装

**Files:**
- Modify: `src/lib/abr_data/merge_chiban_duckdb_csv.ts`
- Modify: `src/lib/abr_data/merge_chiban_duckdb_csv.test.ts`
- Create: `test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/main/011002.csv`
- Create: `test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/pos/011002.csv`
- Create: `test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/main-nopos/131059.csv`
- Create: `test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/main.zip`
- Create: `test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/pos.zip`
- Create: `test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/main-nopos.zip`

設計書 §3 の `mergeChibanDataDuckdbCsv(mainHubResult, posHubResult, ctx)` を per-city モードで完成させる。Hub URL 解決 → ZIP cache 読み込み → `unzipToFiles` で temp 展開 → DuckDB instance 起動 (per-city) → LEFT JOIN クエリ → yield → finally で view/instance/temp cleanup の流れ。

設計書 §4.3〜§4.6 を実装ターゲットにする。

- [ ] **Step 1: フィクスチャ CSV を 3 つ作る**

`test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/main/011002.csv` (3 行、prc_id=0001/0002/0003):

```csv
lg_code,machiaza_id,prc_id,city,ward,oaza_cho,chome,koaza,prc_num1,prc_num2,prc_num3,rsdt_addr_flg,prc_rec_flg,prc_area_code,efct_date,ablt_date,src_code,remarks,real_prop_num
011002,0001000,0001,札幌市,中央区,北一条西,,,1,,,0,1,,,,1,,
011002,0001000,0002,札幌市,中央区,北一条西,,,2,,,0,1,,,,1,,
011002,0001000,0003,札幌市,中央区,北一条西,,,3,,,0,1,,,,1,,
```

`test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/pos/011002.csv` (2 行、prc_id=0001/0002 のみ — 0003 はミスヒット):

```csv
lg_code,machiaza_id,prc_id,rep_lon,rep_lat,rep_srid,rep_scale,rep_src_code,plygn_fname,plygn_kcode,plygn_fmt,plygn_srid,plygn_scale,plygn_src_code,moj_map_city_code,moj_map_oaza_code,moj_map_chome_code,moj_map_koaza_code,moj_map_spare_code,moj_map_brushid
011002,0001000,0001,141.34,43.06,6668,2500,1,,,,,,,,,,,,
011002,0001000,0002,141.35,43.07,6668,2500,1,,,,,,,,,,,,
```

`test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/main-nopos/131059.csv` (pos 無し自治体用、2 行):

```csv
lg_code,machiaza_id,prc_id,city,ward,oaza_cho,chome,koaza,prc_num1,prc_num2,prc_num3,rsdt_addr_flg,prc_rec_flg,prc_area_code,efct_date,ablt_date,src_code,remarks,real_prop_num
131059,9999000,A001,新宿区,,西新宿,,,99,,,0,1,,,,1,,
131059,9999000,A002,新宿区,,西新宿,,,99,2,,0,1,,,,1,,
```

`mkdir -p` で親ディレクトリも作る:

```bash
mkdir -p test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/{main,pos,main-nopos}
# 上記 3 つの CSV を Write ツールでそれぞれ作成
```

- [ ] **Step 2: フィクスチャ ZIP を 3 つ作る**

```bash
cd test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/
( cd main      && zip -j ../main.zip      011002.csv )
( cd pos       && zip -j ../pos.zip       011002.csv )
( cd main-nopos && zip -j ../main-nopos.zip 131059.csv )
cd -
ls -la test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/*.zip
```

Expected: 3 つの ZIP がそれぞれ数百バイトで生成される (`-j` でディレクトリ階層を含めず格納。03 の fixture と同じ flat 形式)。

- [ ] **Step 3: 統合テストを書く**

`src/lib/abr_data/merge_chiban_duckdb_csv.test.ts` の末尾に追記:

```ts
import os from 'node:os';
import path from 'node:path';

import {
  mergeChibanDataDuckdbCsv,
  type ChibanDuckdbCtx,
  type ChibanDuckdbLifecycle,
} from './merge_chiban_duckdb_csv.js';
import type { HubSearchResult } from '../hub.js';

const FIXTURE_ROOT = path.join(
  import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'lib', 'abr_data', 'merge_chiban_duckdb_csv',
);

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

function makeHubResult(url: string, lg_code: string): HubSearchResult {
  return {
    type: 'Feature',
    geometry: null,
    properties: { id: `stub-${lg_code}`, title: `stub-${lg_code}`, url },
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
    const mainUrl = 'https://example.test/main.zip';
    const posUrl  = 'https://example.test/pos.zip';
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
    const mainUrl = 'https://example.test/main-nopos.zip';
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
    const mainUrl = 'https://example.test/main.zip';
    const posUrl  = 'https://example.test/pos.zip';
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
    const mainUrl = 'https://example.test/main.zip';
    const posUrl  = 'https://example.test/pos.zip';
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
```

- [ ] **Step 4: テスト失敗を確認**

```bash
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -30
```

Expected: Task 2 で書いた 5 件は pass。今回追加の 5 件 (mergeChibanDataDuckdbCsv 関連) は `mergeChibanDataDuckdbCsv is not a function` で fail。

- [ ] **Step 5: `mergeChibanDataDuckdbCsv` 本体を実装する**

`src/lib/abr_data/merge_chiban_duckdb_csv.ts` の末尾 (`closeChibanDuckdbCtx` の下) に追記:

```ts
import { DuckDBConnection } from '@duckdb/node-api';

import { getDownloadStream } from '../fetch_tools.js';
import { getUrlForCSVResource, type HubSearchResult } from '../hub.js';
import { unzipToFiles } from '../zip_tools.js';
import type { ChibanDataWithPos } from './chiban.js';

const JOIN_KEYS = ['lg_code', 'machiaza_id', 'prc_id'] as const;
const POS_COLS = ['rep_lon', 'rep_lat', 'rep_srid', 'rep_scale', 'rep_src_code'] as const;

/** Hub URL から lg_code (6 桁数字) を抽出する。失敗時は throw。 */
function extractLgCodeFromHubResult(
  hubResult: HubSearchResult,
): string {
  const url = getUrlForCSVResource(hubResult);
  if (!url) throw new Error(`mergeChibanDataDuckdbCsv: no CSV URL on HubSearchResult`);
  const m = /(\d{6})_csv_zip$/.exec(url);
  if (!m) {
    throw new Error(
      `mergeChibanDataDuckdbCsv: cannot extract lg_code from URL "${url}" (expected /(\\d{6})_csv_zip$/)`,
    );
  }
  if (!/^[0-9]+$/.test(m[1])) {
    throw new Error(`mergeChibanDataDuckdbCsv: invalid lg_code "${m[1]}" (must be [0-9]+)`);
  }
  return m[1];
}

/** 1 自治体分の CSV を tempRoot/city-<lg_code>/{main,pos}/ に展開する。 */
async function extractCityZipsToTemp(
  cityRoot: string,
  mainHubResult: HubSearchResult,
  posHubResult: HubSearchResult | undefined,
): Promise<{ mainDir: string; posDir?: string }> {
  const mainDir = path.join(cityRoot, 'main');
  await fs.mkdir(mainDir, { recursive: true });
  {
    const url = getUrlForCSVResource(mainHubResult);
    if (!url) throw new Error(`mergeChibanDataDuckdbCsv: no CSV URL on main HubSearchResult`);
    const buffer = await getDownloadStream(url);
    await unzipToFiles(buffer, mainDir);
  }
  if (!posHubResult) return { mainDir };
  const posDir = path.join(cityRoot, 'pos');
  await fs.mkdir(posDir, { recursive: true });
  const url = getUrlForCSVResource(posHubResult);
  if (!url) throw new Error(`mergeChibanDataDuckdbCsv: no CSV URL on pos HubSearchResult`);
  const buffer = await getDownloadStream(url);
  await unzipToFiles(buffer, posDir);
  return { mainDir, posDir };
}

/** 設計書 §4.2 の DuckDB セッション設定を connection に適用。 */
async function configureDuckdbConnection(
  connection: DuckDBConnection,
  spillDir: string,
): Promise<void> {
  const cores = os.cpus().length;
  const concurrency = parseInt(process.env.CHIBAN_CONCURRENCY ?? '4', 10);
  const threads = Math.max(1, Math.floor(cores / concurrency));
  const memoryGb = Math.max(2, threads * 3);
  await connection.run(`SET threads = ${threads}`);
  await connection.run('SET preserve_insertion_order = false');
  await connection.run(`SET temp_directory = '${spillDir.replace(/'/g, "''")}'`);
  await connection.run(`PRAGMA memory_limit = '${memoryGb}GB'`);
}

/** lg_code, machiaza_id, prc_id を JOIN キーとして SQL を組み立てる (設計書 §4.4)。 */
function buildJoinSql(lg_code: string, hasPos: boolean): string {
  const orderClause = JOIN_KEYS.map((k) => `COALESCE(l.${k}, '')`).join(', ');
  if (!hasPos) {
    const posCols = POS_COLS.map((c) => `NULL AS ${c}`).join(', ');
    return `
      SELECT l.*, ${posCols}
      FROM l_${lg_code} AS l
      ORDER BY ${orderClause}
    `;
  }
  const onClause = JOIN_KEYS
    .map((k) => `l.${k} IS NOT DISTINCT FROM r.${k}`)
    .join(' AND ');
  const posCols = POS_COLS.map((c) => `r.${c}`).join(', ');
  return `
    SELECT l.*, ${posCols}
    FROM l_${lg_code} AS l
    LEFT JOIN r_${lg_code} AS r ON ${onClause}
    ORDER BY ${orderClause}
  `;
}

/**
 * 設計書 §3 の公開 API。
 * mainHubResult / 任意 posHubResult を受け、ZIP を temp に展開して
 * DuckDB の LEFT JOIN 結果を 1 行ずつ yield する。
 *
 * Phase 1 では ctx.lifecycle='percity' のみサポート (instance を都度作成・破棄)。
 */
export async function* mergeChibanDataDuckdbCsv(
  mainHubResult: HubSearchResult,
  posHubResult: HubSearchResult | undefined,
  ctx: ChibanDuckdbCtx,
): AsyncIterableIterator<ChibanDataWithPos> {
  const lg_code = extractLgCodeFromHubResult(mainHubResult);
  const cityRoot = path.join(ctx.tempRoot, `city-${lg_code}`);
  await fs.mkdir(cityRoot, { recursive: true });

  const { mainDir, posDir } = await extractCityZipsToTemp(
    cityRoot, mainHubResult, posHubResult,
  );

  // Phase 1: percity モード固定 (shared は Phase 2 で実装)
  const dbDir = path.join(ctx.tempRoot, `db-${lg_code}`);
  await fs.mkdir(dbDir, { recursive: true });
  const spillDir = path.join(dbDir, 'duckdb-spill');
  await fs.mkdir(spillDir, { recursive: true });

  let instance: DuckDBInstance | undefined;
  let connection: DuckDBConnection | undefined;
  try {
    instance = await DuckDBInstance.create(path.join(dbDir, 'db.duckdb'));
    connection = await instance.connect();
    await configureDuckdbConnection(connection, spillDir);

    const mainGlob = path.join(mainDir, '*.csv').replace(/'/g, "''");
    await connection.run(
      `CREATE TEMP VIEW l_${lg_code} AS SELECT * FROM read_csv_auto('${mainGlob}', header=true, parallel=true, all_varchar=true)`,
    );
    if (posDir) {
      const posGlob = path.join(posDir, '*.csv').replace(/'/g, "''");
      await connection.run(
        `CREATE TEMP VIEW r_${lg_code} AS SELECT * FROM read_csv_auto('${posGlob}', header=true, parallel=true, all_varchar=true)`,
      );
    }

    const sql = buildJoinSql(lg_code, posDir !== undefined);
    const result = await connection.stream(sql);
    for await (const rowObjects of result.yieldRowObjects()) {
      for (const row of rowObjects) {
        yield row as unknown as ChibanDataWithPos;
      }
    }
  } finally {
    try {
      if (connection) {
        await connection.run(`DROP VIEW IF EXISTS l_${lg_code}`);
        if (posDir) await connection.run(`DROP VIEW IF EXISTS r_${lg_code}`);
      }
    } catch { /* ignore */ }
    try { connection?.closeSync(); } catch { /* ignore */ }
    try { instance?.closeSync(); }   catch { /* ignore */ }
    // percity: city CSV temp も dbDir もここで rm
    await fs.rm(cityRoot, { recursive: true, force: true }).catch((e: unknown) => {
      console.warn(`mergeChibanDataDuckdbCsv: cityRoot cleanup failed: ${cityRoot}`, e);
    });
    await fs.rm(dbDir, { recursive: true, force: true }).catch((e: unknown) => {
      console.warn(`mergeChibanDataDuckdbCsv: dbDir cleanup failed: ${dbDir}`, e);
    });
  }
}
```

注意: 設計書 §4.6 では「per-city モードでも cityRoot は close 側で一括 rm するため per-city では削除しない」と書かれているが、Phase 1 の単純な実装方針 (per-city モードは「都度作って都度消す」を徹底) に揃えるため、ここでは cityRoot/dbDir ともに per-city finally で消す。Phase 2 で shared モード対応時に「shared なら closeChibanDuckdbCtx 側で消す」分岐を追加する。

- [ ] **Step 6: テスト pass を確認**

```bash
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -30
```

Expected: 全 10 件 pass (Task 2 の 5 件 + Task 3 の 5 件)。

- [ ] **Step 7: lint と build**

```bash
npm run lint -- --max-warnings 0 src/lib/abr_data/merge_chiban_duckdb_csv.ts src/lib/abr_data/merge_chiban_duckdb_csv.test.ts
npm run build:dev
```

Expected: 0 error / 0 warning。`any` ゼロ目標 (設計書 §6.4)。

- [ ] **Step 8: 既存テスト全体に影響が無いことを確認**

```bash
npm run test 2>&1 | tail -20
```

Expected: 全テストファイル pass。03 PoC の `merge_duckdb_csv.test.ts` も含めて緑。

- [ ] **Step 9: コミット**

```bash
git add src/lib/abr_data/merge_chiban_duckdb_csv.ts src/lib/abr_data/merge_chiban_duckdb_csv.test.ts \
        test/fixtures/lib/abr_data/merge_chiban_duckdb_csv/
git commit -m "Add mergeChibanDataDuckdbCsv per-city mode with NULL-safe LEFT JOIN"
```

---

## Self-Review チェックリスト (Phase 1)

実装完了直後に以下を眼で確認:

1. **Spec coverage (Phase 1 範囲)**: 設計書 §3 の `ChibanDuckdbLifecycle` / `ChibanDuckdbCtx` / `createChibanDuckdbCtx` / `closeChibanDuckdbCtx` / `mergeChibanDataDuckdbCsv` の型シグネチャが全て定義されていること。§4.4 の NULL-safe JOIN、ORDER BY の COALESCE 正規化、§4.5 のストリーミング yield が実装されていること。
2. **Placeholder scan**: plan 全文に「TBD」「TODO」「あとで」「実装してください」が無いか確認。
3. **Type / signature 一貫性**:
   - `ChibanDuckdbCtx.instance: DuckDBInstance | undefined` が Phase 1 では常に undefined であること
   - `mergeChibanDataDuckdbCsv(mainHubResult, posHubResult, ctx)` の引数順が Phase 2/3 と一貫 (テストでも同じ順序で呼ばれている)
4. **既存 API 不変**: `merge_duckdb_csv.ts` / `merge_sqlite.ts` / `merge_duckdb.ts` / `index.ts` / `04_make_chiban.ts` を本 Phase で**一切変更していない**こと (設計書 §1 非ゴール)。
5. **既知 descope**: shared モードは Phase 2、caller 配線は Phase 2、ベンチは Phase 3。Phase 1 完了状態では `npm run run:04_make_chiban` は既存挙動 (Map fast-path) で走り、`MERGE_BACKEND=duckdb-csv` を指定しても 04 には影響しない (caller 未配線のため)。
6. **temp cleanup の責務**: Phase 1 では cityRoot/dbDir ともに per-city モードの finally で削除する単純実装。Phase 2 の shared モード追加時に「shared なら close 側で削除」分岐を入れることが Phase 2 計画書で言及されていること。

---

## Phase 2 への引き継ぎ

Phase 1 完了状態: `src/lib/abr_data/merge_chiban_duckdb_csv.ts` で per-city モードが動く。`createChibanDuckdbCtx('shared')` を呼ぶと throw する状態。次フェーズ ([`2026-05-23-duckdb-tier3-poc-chiban-02-shared-and-caller.md`](./2026-05-23-duckdb-tier3-poc-chiban-02-shared-and-caller.md)) で shared モードと caller 配線を追加する。
