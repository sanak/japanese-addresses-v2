# DuckDB Tier 3 PoC for 04_make_chiban — Phase 2: Shared Lifecycle + Caller Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 で完成した per-city モード実装に shared lifecycle を追加し、`04_make_chiban.ts` caller に env 分岐 (`MERGE_BACKEND=duckdb-csv` + `CHIBAN_DUCKDB_LIFECYCLE=shared|percity`) を配線する。完了状態では `MERGE_BACKEND=duckdb-csv` 指定時に Map fast-path をバイパスして DuckDB 経路が動き、未指定時は既存 Map fast-path がそのまま走る。

**Architecture:** `createChibanDuckdbCtx('shared')` で `DuckDBInstance` を 1 度だけ生成し ctx に保持。`mergeChibanDataDuckdbCsv` 内部で `ctx.lifecycle === 'shared'` 時は per-city DuckDB instance を作らず ctx.instance から `connection = await ctx.instance.connect()` を取得。view 命名 (`l_<lg_code>` / `r_<lg_code>`) と SQL は両モード共通。`04_make_chiban.ts` の `main()` 先頭で ctx 生成、`processCity()` の merge 呼び出し直前で env 分岐し、Map fast-path もそのまま並走させる。LEFT JOIN ミスヒット行の判定を `'rep_srid' in raw` → `raw.rep_srid != null` に修正。

**Tech Stack:** TypeScript, Node.js 22, `@duckdb/node-api` ^1.5.3, `node:test` + `node:assert`, `tsx`

**Related spec:** [`docs/superpowers/specs/2026-05-23-duckdb-tier3-poc-chiban-design.md`](../specs/2026-05-23-duckdb-tier3-poc-chiban-design.md)

**Phase 1 (prerequisite):** [`2026-05-23-duckdb-tier3-poc-chiban-01-foundation.md`](./2026-05-23-duckdb-tier3-poc-chiban-01-foundation.md)
**Phase 3:** [`2026-05-23-duckdb-tier3-poc-chiban-03-verification-and-bench.md`](./2026-05-23-duckdb-tier3-poc-chiban-03-verification-and-bench.md)

---

## Pre-flight

- [ ] **Step 1: Phase 1 が完了していることを確認**

```bash
git log --oneline -5
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -5
```

Expected: 直近 3 コミットに `Add ChibanDataWithPos type`, `Add ChibanDuckdbCtx lifecycle skeleton`, `Add mergeChibanDataDuckdbCsv per-city mode` (or 同等) が並んでいる。テストは 10 件 pass。

- [ ] **Step 2: 04 caller の現状行番号を把握する**

```bash
sed -n '90,160p' src/processes/04_make_chiban.ts
```

Expected: line 95 `async function processCity(...)`、line 113 `const mainStream = ...`、line 120 `const rawData = mergeDataLeftJoin(mainStream, posStream, ['lg_code', 'machiaza_id', 'prc_id'], true)`、line 146 `point: 'rep_srid' in raw ? projectABRData(raw) : undefined` が見える。本 Phase で line 120 と line 146 を変更し、`main()` 側にも ctx 生成を追加する。

---

## Task 4: `createChibanDuckdbCtx('shared')` を実装

**Files:**
- Modify: `src/lib/abr_data/merge_chiban_duckdb_csv.ts`
- Modify: `src/lib/abr_data/merge_chiban_duckdb_csv.test.ts`

設計書 §4.2 の shared モード初期化処理を `createChibanDuckdbCtx` に追加し、Phase 1 で `throw new Error(... Phase 2)` していた分岐を実装で置換する。`closeChibanDuckdbCtx` 側は Phase 1 で既に `ctx.instance.closeSync()` 経路を持っているので追加変更不要。

- [ ] **Step 1: 失敗テストを書く**

`src/lib/abr_data/merge_chiban_duckdb_csv.test.ts` の Task 2 で書いた `describe('createChibanDuckdbCtx (percity)', ...)` ブロックの**直後**に追加:

```ts
await describe('createChibanDuckdbCtx (shared)', async () => {
  await test('returns ctx with lifecycle=shared and live DuckDBInstance', async () => {
    const ctx = await createChibanDuckdbCtx('shared');
    try {
      assert.strictEqual(ctx.lifecycle, 'shared');
      assert.notStrictEqual(ctx.instance, undefined);
      const stat = await fs.stat(ctx.tempRoot);
      assert.ok(stat.isDirectory());
      // instance が連結可能であることを軽量に確認
      const conn = await ctx.instance!.connect();
      try {
        const r = await conn.run('SELECT 1 AS v');
        const rows = await r.getRowObjects();
        assert.strictEqual((rows[0] as { v: number | bigint }).v.toString(), '1');
      } finally {
        conn.closeSync();
      }
    } finally {
      await closeChibanDuckdbCtx(ctx);
    }
  });

  await test('closeChibanDuckdbCtx closes shared instance and removes tempRoot', async () => {
    const ctx = await createChibanDuckdbCtx('shared');
    const tempRoot = ctx.tempRoot;
    await closeChibanDuckdbCtx(ctx);
    assert.strictEqual(ctx.instance, undefined); // close 後は nulled out
    await assert.rejects(() => fs.stat(tempRoot), /ENOENT/);
  });
});
```

そして Task 2 で書いた "rejects shared lifecycle in Phase 1" テストを**削除** (この時点で shared が valid になるため):

```ts
// 以下のブロックは削除:
//   await test('rejects shared lifecycle in Phase 1 (not yet implemented)', ...);
```

- [ ] **Step 2: テスト失敗を確認**

```bash
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -30
```

Expected: 新規 2 件が「shared lifecycle is not yet implemented」で fail (現在の throw)。既存テスト 9 件 (削除した 1 件を除く Phase 1 の 4+5 件) は pass。

- [ ] **Step 3: `createChibanDuckdbCtx` を shared 対応に拡張する**

`src/lib/abr_data/merge_chiban_duckdb_csv.ts` の `createChibanDuckdbCtx` 関数を以下に置換:

```ts
/**
 * 04_make_chiban の main() 先頭で 1 度呼ぶ。lifecycle に応じ instance を生成または空 ctx を返す。
 */
export async function createChibanDuckdbCtx(
  lifecycle: ChibanDuckdbLifecycle,
): Promise<ChibanDuckdbCtx> {
  if (lifecycle !== 'shared' && lifecycle !== 'percity') {
    throw new Error(
      `createChibanDuckdbCtx: unknown lifecycle "${String(lifecycle)}", expected 'shared' | 'percity'`,
    );
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chiban-duckdb-csv-'));
  if (lifecycle === 'percity') {
    return { lifecycle, instance: undefined, tempRoot };
  }
  // shared: 1 process で 1 instance を共有する
  const dbPath = path.join(tempRoot, 'db.duckdb');
  const spillDir = path.join(tempRoot, 'duckdb-spill');
  await fs.mkdir(spillDir, { recursive: true });
  const instance = await DuckDBInstance.create(dbPath);
  const setup = await instance.connect();
  try {
    await configureDuckdbConnection(setup, spillDir);
  } finally {
    setup.closeSync();
  }
  return { lifecycle, instance, tempRoot };
}
```

注意:
- `configureDuckdbConnection` は Phase 1 で per-city モード用に既に同ファイルに定義済み (Task 3 Step 5)。shared モードでも同じ関数で初期化することで、両モードの DuckDB 設定 (threads / preserve_insertion_order / temp_directory / memory_limit) を完全に揃える。
- setup 専用 connection は initial PRAGMA 適用のためだけに開いてすぐ閉じる。processCity 側で都度 `instance.connect()` を呼ぶ前提。

- [ ] **Step 4: テスト pass を確認**

```bash
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -30
```

Expected: 全 11 件 pass (Phase 1 から 1 件削除 +2 件追加で純増 1)。

- [ ] **Step 5: lint と build**

```bash
npm run lint -- --max-warnings 0 src/lib/abr_data/merge_chiban_duckdb_csv.ts src/lib/abr_data/merge_chiban_duckdb_csv.test.ts
npm run build:dev
```

Expected: 0 error / 0 warning。

- [ ] **Step 6: コミット**

```bash
git add src/lib/abr_data/merge_chiban_duckdb_csv.ts src/lib/abr_data/merge_chiban_duckdb_csv.test.ts
git commit -m "Implement shared lifecycle in createChibanDuckdbCtx"
```

---

## Task 5: `mergeChibanDataDuckdbCsv` に shared モード分岐を入れる

**Files:**
- Modify: `src/lib/abr_data/merge_chiban_duckdb_csv.ts`
- Modify: `src/lib/abr_data/merge_chiban_duckdb_csv.test.ts`

Phase 1 の `mergeChibanDataDuckdbCsv` は ctx.lifecycle を見ずに常に per-city instance を作っていた。Phase 2 では `ctx.lifecycle === 'shared'` のとき ctx.instance から connect を取り、city CSV temp の cleanup 責務もモード別に切り替える (設計書 §4.6 / §4.7)。

- [ ] **Step 1: shared モードの失敗テストを書く**

`src/lib/abr_data/merge_chiban_duckdb_csv.test.ts` の末尾に追記:

```ts
await describe('mergeChibanDataDuckdbCsv (shared)', async () => {
  await test('sequential 2 cities on same shared ctx: both yield correct rows', async () => {
    const mainUrl1 = 'https://example.test/main.zip';      // lg_code=011002
    const posUrl1  = 'https://example.test/pos.zip';
    const mainUrl2 = 'https://example.test/main-nopos.zip'; // lg_code=131059
    const rows1: unknown[] = [];
    const rows2: unknown[] = [];
    await withCachedZipFixture(
      [
        { url: mainUrl1, fixturePath: path.join(FIXTURE_ROOT, 'main.zip') },
        { url: posUrl1,  fixturePath: path.join(FIXTURE_ROOT, 'pos.zip') },
        { url: mainUrl2, fixturePath: path.join(FIXTURE_ROOT, 'main-nopos.zip') },
      ],
      async () => withCtx('shared', async (ctx) => {
        for await (const r of mergeChibanDataDuckdbCsv(
          makeHubResult(mainUrl1, '011002'), makeHubResult(posUrl1, '011002'), ctx,
        )) rows1.push(r);
        for await (const r of mergeChibanDataDuckdbCsv(
          makeHubResult(mainUrl2, '131059'), undefined, ctx,
        )) rows2.push(r);
      }),
    );
    assert.strictEqual(rows1.length, 3);
    assert.strictEqual(rows2.length, 2);
  });

  await test('parallel 2 cities on same shared ctx: both yield correct rows', async () => {
    const mainUrl1 = 'https://example.test/main.zip';
    const posUrl1  = 'https://example.test/pos.zip';
    const mainUrl2 = 'https://example.test/main-nopos.zip';
    let rows1: unknown[] = [];
    let rows2: unknown[] = [];
    await withCachedZipFixture(
      [
        { url: mainUrl1, fixturePath: path.join(FIXTURE_ROOT, 'main.zip') },
        { url: posUrl1,  fixturePath: path.join(FIXTURE_ROOT, 'pos.zip') },
        { url: mainUrl2, fixturePath: path.join(FIXTURE_ROOT, 'main-nopos.zip') },
      ],
      async () => withCtx('shared', async (ctx) => {
        [rows1, rows2] = await Promise.all([
          Array.fromAsync(mergeChibanDataDuckdbCsv(
            makeHubResult(mainUrl1, '011002'), makeHubResult(posUrl1, '011002'), ctx,
          )),
          Array.fromAsync(mergeChibanDataDuckdbCsv(
            makeHubResult(mainUrl2, '131059'), undefined, ctx,
          )),
        ]);
      }),
    );
    assert.strictEqual(rows1.length, 3);
    assert.strictEqual(rows2.length, 2);
  });

  await test('shared: city-<lg_code> temp persists until closeChibanDuckdbCtx', async () => {
    const mainUrl = 'https://example.test/main.zip';
    const posUrl  = 'https://example.test/pos.zip';
    let tempRoot = '';
    await withCachedZipFixture(
      [
        { url: mainUrl, fixturePath: path.join(FIXTURE_ROOT, 'main.zip') },
        { url: posUrl,  fixturePath: path.join(FIXTURE_ROOT, 'pos.zip') },
      ],
      async () => {
        const ctx = await createChibanDuckdbCtx('shared');
        tempRoot = ctx.tempRoot;
        try {
          await Array.fromAsync(mergeChibanDataDuckdbCsv(
            makeHubResult(mainUrl, '011002'), makeHubResult(posUrl, '011002'), ctx,
          ));
          // close 前: city-011002/ が残っている (shared モードの責務分担)
          const entries = await fs.readdir(ctx.tempRoot);
          assert.ok(entries.some((n) => n === 'city-011002'),
            `expected city-011002 in ${ctx.tempRoot}, got: ${entries.join(', ')}`);
        } finally {
          await closeChibanDuckdbCtx(ctx);
        }
        // close 後: tempRoot 配下ごと消えている
        await assert.rejects(() => fs.stat(tempRoot), /ENOENT/);
      },
    );
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

```bash
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -30
```

Expected: 新規 3 件 fail。1 件目 / 2 件目は「同じ instance に対する 2 自治体の view 作成で何かおかしい」系の error、3 件目は「city-011002 が見つからない」系の error (Phase 1 の per-city finally で消されているため)。

- [ ] **Step 3: `mergeChibanDataDuckdbCsv` を shared 分岐対応にする**

`src/lib/abr_data/merge_chiban_duckdb_csv.ts` の `mergeChibanDataDuckdbCsv` 関数の本体 (Phase 1 Task 3 Step 5 で書いた部分) を以下に置換:

```ts
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

  // モード別に instance / dbDir を準備する
  let perCityInstance: DuckDBInstance | undefined;
  let perCityDbDir: string | undefined;
  let instanceToUse: DuckDBInstance;
  if (ctx.lifecycle === 'shared') {
    if (!ctx.instance) {
      throw new Error(`mergeChibanDataDuckdbCsv: shared ctx without instance (createChibanDuckdbCtx を main() 先頭で呼んでいない可能性)`);
    }
    instanceToUse = ctx.instance;
  } else {
    perCityDbDir = path.join(ctx.tempRoot, `db-${lg_code}`);
    await fs.mkdir(perCityDbDir, { recursive: true });
    const spillDir = path.join(perCityDbDir, 'duckdb-spill');
    await fs.mkdir(spillDir, { recursive: true });
    perCityInstance = await DuckDBInstance.create(path.join(perCityDbDir, 'db.duckdb'));
    const setup = await perCityInstance.connect();
    try {
      await configureDuckdbConnection(setup, spillDir);
    } finally {
      setup.closeSync();
    }
    instanceToUse = perCityInstance;
  }

  let connection: DuckDBConnection | undefined;
  try {
    connection = await instanceToUse.connect();

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
    if (ctx.lifecycle === 'percity') {
      try { perCityInstance?.closeSync(); } catch { /* ignore */ }
      // percity: city CSV temp も dbDir もここで rm
      await fs.rm(cityRoot, { recursive: true, force: true }).catch((e: unknown) => {
        console.warn(`mergeChibanDataDuckdbCsv: cityRoot cleanup failed: ${cityRoot}`, e);
      });
      if (perCityDbDir) {
        await fs.rm(perCityDbDir, { recursive: true, force: true }).catch((e: unknown) => {
          console.warn(`mergeChibanDataDuckdbCsv: dbDir cleanup failed: ${perCityDbDir}`, e);
        });
      }
    }
    // shared: instance/cityRoot は closeChibanDuckdbCtx 側で一括 rm するので per-city finally では消さない
  }
}
```

- [ ] **Step 4: テスト pass を確認**

```bash
node --test --import tsx ./src/lib/abr_data/merge_chiban_duckdb_csv.test.ts 2>&1 | tail -30
```

Expected: 全 14 件 pass (Phase 1 残存 9 件 + shared ctx 2 件 + shared merge 3 件)。

- [ ] **Step 5: lint と build**

```bash
npm run lint -- --max-warnings 0 src/lib/abr_data/merge_chiban_duckdb_csv.ts src/lib/abr_data/merge_chiban_duckdb_csv.test.ts
npm run build:dev
```

Expected: 0 error / 0 warning。

- [ ] **Step 6: コミット**

```bash
git add src/lib/abr_data/merge_chiban_duckdb_csv.ts src/lib/abr_data/merge_chiban_duckdb_csv.test.ts
git commit -m "Branch mergeChibanDataDuckdbCsv on ctx.lifecycle for shared mode"
```

---

## Task 6: `04_make_chiban.ts` caller に env 分岐と null 判定修正を入れる

**Files:**
- Modify: `src/processes/04_make_chiban.ts`

設計書 §3 のアーキテクチャ図に従って、4 点を修正する:

1. `import` 追加: `mergeChibanDataDuckdbCsv`, `createChibanDuckdbCtx`, `closeChibanDuckdbCtx`, `ChibanDuckdbCtx`, `ChibanDuckdbLifecycle`
2. `main()` 先頭で `MERGE_BACKEND === 'duckdb-csv'` のとき ctx を生成、末尾で close
3. `processCity()` の signature に ctx?: を追加し、ctx 有時は `mergeChibanDataDuckdbCsv` を呼ぶ env 分岐
4. line 146 の `'rep_srid' in raw` を `raw.rep_srid != null` に修正 (LEFT JOIN ミスヒット判定)

- [ ] **Step 1: 既存 caller を確認**

```bash
sed -n '1,20p' src/processes/04_make_chiban.ts
sed -n '90,160p' src/processes/04_make_chiban.ts
sed -n '160,220p' src/processes/04_make_chiban.ts
```

参照ポイント:
- line 4-14 が既存 import
- line 95-159 が `processCity` 関数
- line 113 が `mainStream`、line 114 が `posStream`、line 120 が `mergeDataLeftJoin(..., true)` 呼出
- line 146 が `'rep_srid' in raw ? projectABRData(raw) : undefined`
- line 161-214 が `main` 関数 (line 197-213 が processCity の Promise.race 並列ループ)

- [ ] **Step 2: import 追加**

`src/processes/04_make_chiban.ts` の line 4-14 にある既存 import 群を以下のように変更する。

1. **既存の line 13** (chiban 関連 import) を以下に置換 — `ChibanDataWithPos` を同じ import 文に併合 (`chiban.js` から二重 import しないため):

```ts
import { ChibanData, ChibanPosData, type ChibanDataWithPos } from '../lib/abr_data/chiban.js';
```

2. **既存 import 群の末尾** (現状 line 14 の `mergeDataLeftJoin` import の直後) に、新規モジュール `merge_chiban_duckdb_csv` からの import を 1 ブロック追加:

```ts
import {
  createChibanDuckdbCtx,
  closeChibanDuckdbCtx,
  mergeChibanDataDuckdbCsv,
  type ChibanDuckdbCtx,
  type ChibanDuckdbLifecycle,
} from '../lib/abr_data/merge_chiban_duckdb_csv.js';
```

- [ ] **Step 3: `processCity` signature と本体に ctx 分岐を入れる**

`processCity` 関数 (line 95) のシグネチャを以下に変更:

```ts
async function processCity(
  ma: MachiAzaData,
  machiAzaDataByCode: Map<string, MachiAzaData>,
  outDir: string,
  ctx: ChibanDuckdbCtx | undefined,
): Promise<void> {
```

line 113-120 の merge セットアップを以下に置換:

```ts
  let rawData: AsyncIterableIterator<ChibanDataWithPos>;
  if (ctx) {
    rawData = mergeChibanDataDuckdbCsv(chibanDataRef, chibanPosDataRef, ctx);
  } else {
    const mainStream = getAndStreamCSVDataForId<ChibanData>(chibanDataRef.properties.id);
    const posStream = chibanPosDataRef ?
      getAndStreamCSVDataForId<ChibanPosData>(chibanPosDataRef.properties.id)
      :
      // 位置参照拡張データが無い場合もある
      (async function*() {})();
    rawData = mergeDataLeftJoin(mainStream, posStream, ['lg_code', 'machiaza_id', 'prc_id'], true) as AsyncIterableIterator<ChibanDataWithPos>;
  }
```

(変更点: 旧 `mainStream` / `posStream` / `rawData = mergeDataLeftJoin(...)` を `if (ctx)` 分岐で包む。`mergeChibanDataDuckdbCsv` は `HubSearchResult | undefined` を直接受けるので、`chibanPosDataRef` を渡すだけで pos 有無の判定は API 内で行う。)

- [ ] **Step 4: LEFT JOIN ミスヒット判定を修正**

line 146 (`for await (const raw of rawData)` ループ内の `currentChibanList.push({...})` の中):

```ts
      point: raw.rep_srid != null ? projectABRData(raw) : undefined,
```

(変更前: `'rep_srid' in raw ? projectABRData(raw) : undefined`)

設計書 §4.5 / §5 で説明した通り、LEFT JOIN は全カラムを持った row を返し pos ミスヒット行で `rep_srid` は値 null として存在する。`in` 判定は常に true になってしまうため、`!= null` で null/undefined 両方を弾く判定に修正する。`projectABRData(raw)` は `raw.rep_srid: string` を要求するため、null 行で呼ばれないことが重要。

ただし `raw.rep_srid` の型は `ChibanDataWithPos` (= `ChibanData | ChibanData & ChibanPosData`) では narrow できないので、type predicate を導入して TypeScript narrowing を補助する。`processCity` 関数の**直前**に以下を追加 (line 94 付近):

```ts
function hasPos(raw: ChibanDataWithPos): raw is ChibanData & ChibanPosData {
  return (raw as Partial<ChibanPosData>).rep_srid != null;
}
```

そして line 146 を更に以下に変更:

```ts
      point: hasPos(raw) ? projectABRData(raw) : undefined,
```

- [ ] **Step 5: `main()` で ctx を生成・close する**

`main()` 関数の `console.log('事前準備: 町字データを取得しました');` (line 185 付近) の直後に以下を追加:

```ts
  let ctx: ChibanDuckdbCtx | undefined;
  if (process.env.MERGE_BACKEND === 'duckdb-csv') {
    const lifecycle = (process.env.CHIBAN_DUCKDB_LIFECYCLE ?? 'shared') as ChibanDuckdbLifecycle;
    ctx = await createChibanDuckdbCtx(lifecycle);
    console.log(`MERGE_BACKEND=duckdb-csv with CHIBAN_DUCKDB_LIFECYCLE=${lifecycle}`);
  }
```

`progress.start(machiAzas.length, 0);` の直前または直後 (どちらでも可、現状コードに近い形で挿入)。

そして `try { ... } finally { progress.stop(); }` ブロック (line 197-213) の `finally { progress.stop(); }` を以下に拡張:

```ts
  } finally {
    progress.stop();
    if (ctx) await closeChibanDuckdbCtx(ctx);
  }
```

最後に `processCity(ma, machiAzaDataByCode, outDir)` (line 200) の呼出を `processCity(ma, machiAzaDataByCode, outDir, ctx)` に変更。

- [ ] **Step 6: lint と build 確認**

```bash
npm run lint -- --max-warnings 0 src/processes/04_make_chiban.ts
npm run build:dev
```

Expected: 0 error / 0 warning。`any` ゼロ。

- [ ] **Step 7: 既存テスト全体に影響が無いことを確認**

```bash
npm run test 2>&1 | tail -30
```

Expected: 全テストファイル pass。特に `src/processes/04_make_chiban.test.ts` (もし存在すれば) は `MERGE_BACKEND` 未指定で動くので既存挙動のままのはず。

- [ ] **Step 8: コミット**

```bash
git add src/processes/04_make_chiban.ts
git commit -m "Wire MERGE_BACKEND=duckdb-csv branch into 04_make_chiban"
```

---

## Task 7: lint + build + 全テスト sweep

**Files:** なし (検証のみ)

Task 4–6 の変更が、リポジトリ全体の lint / type / test を壊していないか確認する。03 PoC plan §Task 6 と同じく集約 step として置く。

- [ ] **Step 1: lint 全体**

```bash
npm run lint
```

Expected: 0 error / 0 warning。

- [ ] **Step 2: tsc 全体**

```bash
npm run build:dev
```

Expected: 0 error。

- [ ] **Step 3: テストランナー全体**

```bash
npm run test 2>&1 | tail -40
```

Expected: 全テストファイル pass。失敗した場合の切り分け:

| 失敗箇所 | 疑うべき変更 |
|---|---|
| `merge_chiban_duckdb_csv.test.ts` | Task 4 / Task 5 のロジック |
| `04_make_chiban.test.ts` (もしあれば) | Task 6 の signature 変更 (`processCity` の 4 引数化) |
| 03 PoC の `merge_duckdb_csv.test.ts` | 触っていないはずなので回帰していたら別問題 |

- [ ] **Step 4: smoke run (任意、ネットワーク要)**

```bash
# 小規模 settings で実際に 04 を走らせて、duckdb-csv 経路が落ちないことだけ確認 (出力比較は Phase 3 で実施)
rm -rf out/api
SETTINGS_JSON='{"lgCodes":["^011002$"]}' \
  MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE=percity \
  npm run run:04_make_chiban 2>&1 | tail -10
ls out/api/北海道/札幌市中央区-地番.txt 2>&1
```

Expected: 1 ファイル `札幌市中央区-地番.txt` が生成される。エラーで落ちなければ Phase 3 に進める。

ネットワーク到達できない (CI 等) 場合はスキップしてよい。

- [ ] **Step 5: コミット (修正があった場合のみ)**

```bash
git status
# (差分があれば)
git add -p
git commit -m "Fix cross-module lint/type/test issues from chiban Tier 3 PoC"
```

差分が無ければこの step はスキップしてよい。

---

## Self-Review チェックリスト (Phase 2)

実装完了直後に以下を眼で確認:

1. **Spec coverage (Phase 2 範囲)**: 設計書 §4.2 の shared モード初期化 (DuckDBInstance.create + configureDuckdbConnection の setup connection 経由)、§4.6 の per-city / shared の cleanup 責務分担、§3 caller の env 分岐 + ctx 受け渡し、§4.5 の `raw.rep_srid != null` 判定が全て実装されていること。
2. **Placeholder scan**: plan 全文に「TBD」「TODO」「あとで」「実装してください」が無いか確認。
3. **Type / signature 一貫性**:
   - `processCity(ma, machiAzaDataByCode, outDir, ctx)` の引数順が呼出側 (line 200) と関数定義 (line 95) で一致
   - `mergeChibanDataDuckdbCsv(mainHubResult, posHubResult, ctx)` の引数順が caller と test と本体で一致
   - `CHIBAN_DUCKDB_LIFECYCLE` のデフォルト値 `'shared'` が caller / 設計書 §2 / Phase 3 ベンチで一致
4. **既存 API 不変**: `merge_duckdb_csv.ts` / `merge_sqlite.ts` / `merge_duckdb.ts` / `index.ts` を本 Phase で**一切変更していない**こと。`04_make_chiban.ts` の Map fast-path 経路 (`mergeDataLeftJoin(..., true)`) は `ctx === undefined` 時にそのまま走るので、`MERGE_BACKEND` 未指定の挙動が変わらないこと。
5. **既知 descope**: 等価性検証 / ベンチマーク / `bench-results.md` 追記は Phase 3。本 Phase 完了状態では `MERGE_BACKEND=duckdb-csv` を指定すれば動くが、出力が Map 経路と一致するかは未確認。
6. **smoke run の取り扱い**: Step 4 はネットワーク無し環境では飛ばしてよい。Phase 3 Task 8 (等価性テスト) で同等以上の確認を行う。

---

## Phase 3 への引き継ぎ

Phase 2 完了状態: `MERGE_BACKEND=duckdb-csv CHIBAN_DUCKDB_LIFECYCLE={shared,percity}` のいずれの env でも `04_make_chiban` が動く。Map fast-path もそのまま並走可能 (env 未指定時)。出力が Map 経路と byte-exact 同一かはまだ未検証。次フェーズ ([`2026-05-23-duckdb-tier3-poc-chiban-03-verification-and-bench.md`](./2026-05-23-duckdb-tier3-poc-chiban-03-verification-and-bench.md)) で京都府 + 北海道での等価性検証とベンチマーク、bench-results.md への結果追記を行う。
