# 04_make_chiban workerpool process モード対応 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `04_make_chiban` の市区町村ループを workerpool の process モードでも実行可能にし、既存の Promise.race 版と `CHIBAN_PARALLEL` env で切替できるようにする。

**Architecture:** 共通ロジックを `04_make_chiban_lib.ts` に抽出し、main / worker 両方から import。`04_make_chiban_worker.ts` は workerpool worker entry。`04_make_chiban.ts` は env を見て Promise.race 版か workerpool 版を選択する。

**Tech Stack:** TypeScript / Node.js 22 / tsx / workerpool v9.x / `node:test` / cli-progress

**Spec:** `docs/superpowers/specs/2026-05-21-workerpool-process-mode-design.md`

**Branch:** `chiban-workerpool-process-mode`（ベース: `18-optimize-chiban-performance`）

**Known baseline failure:** 開始時点で `02_make_machi_aza.test.ts` の宮崎県えびの市ケース（`eData.length > 100`）が失敗中。本作業のスコープ外で、最終確認時にこの状態が変わっていないことだけ確認する。

---

## File Structure

### 新規作成

- `src/processes/04_make_chiban_lib.ts` — 共通ロジック（`processCity`, `serializeApiDataTxt`, `outputChibanData`, 型）を export
- `src/processes/04_make_chiban_lib.test.ts` — `serializeApiDataTxt` のユニットテスト
- `src/processes/04_make_chiban_worker.ts` — workerpool worker entry

### 修正

- `src/processes/04_make_chiban.ts` — `_lib` から import し、`CHIBAN_PARALLEL` env による分岐を追加
- `package.json` — `workerpool` 依存を追加、`run:04_make_chiban:pool` スクリプトを追加

---

## Task 1: workerpool 依存追加

**Files:**
- Modify: `package.json`

- [ ] **Step 1: package.json に workerpool を追加**

`devDependencies` セクションに workerpool エントリを追加（アルファベット順を保つ）。`unzipper` の直前に挿入する。

```json
    "unzipper": "^0.12.3",
    "workerpool": "^9.2.0"
```

実際の編集箇所（`unzipper` 行の前に `workerpool` 行を入れる）:

```json
"undici": "^7.2.1",
"unzipper": "^0.12.3",
"workerpool": "^9.2.0"
```

注: 末尾要素の `,` は無いので、`unzipper` 行の末尾に `,` を足し、`workerpool` を新規行で追加すること。

- [ ] **Step 2: 依存をインストール**

Run: `npm install`
Expected: warning が出ても `up to date` か `added 1 package` で正常終了。

- [ ] **Step 3: workerpool がロードできるか確認**

Run: `node --input-type=module -e "import wp from 'workerpool'; console.log(typeof wp.pool);"`
Expected output: `function`

- [ ] **Step 4: コミット**

```bash
git add package.json package-lock.json
git commit -m "Add workerpool dependency for process-mode parallelism"
```

---

## Task 2: 共通ロジックを `04_make_chiban_lib.ts` に抽出

このタスクは純粋なリファクタリング。`04_make_chiban.test.ts` が引き続きパスすることが安全網。

**Files:**
- Create: `src/processes/04_make_chiban_lib.ts`
- Modify: `src/processes/04_make_chiban.ts`

- [ ] **Step 1: ベースラインで 04 テストがパスすることを確認**

Run: `node --test --import tsx ./src/processes/04_make_chiban.test.ts`
Expected: `# pass 1` / `# fail 0`（数分かかる、屋久島町の地番取得が走る）

このテストが失敗していたら、それ以外の調査が先。本タスクは中断する。

- [ ] **Step 2: `04_make_chiban_lib.ts` を作成**

新規ファイル `src/processes/04_make_chiban_lib.ts` を以下の内容で作成:

```ts
import fs from 'node:fs';
import path from 'node:path';

import { getHubItemsByQuery, findResultByTypeAndArea, getAndStreamCSVDataForId } from '../lib/hub.js';
import { machiAzaName, SingleChiban, SingleMachiAza } from '../data.js';
import { projectABRData } from '../lib/proj.js';
import { MachiAzaData } from '../lib/abr_data/machi_aza.js';
import { rawToMachiAza } from './02_machi_aza.js';
import { ChibanData, ChibanPosData } from '../lib/abr_data/chiban.js';
import { mergeDataLeftJoin } from '../lib/abr_data/index.js';

export const HEADER_CHUNK_SIZE = 50_000;

export type ChibanApi = {
  machiAza: SingleMachiAza;
  chibans: SingleChiban[];
}[];

export type HeaderRow = {
  name: string;
  offset: number;
  length: number;
}

export function serializeApiDataTxt(apiData: ChibanApi): { headerIterations: number, headerData: HeaderRow[], data: Buffer } {
  const outSections: Buffer[] = [];
  for ( const { machiAza, chibans } of apiData ) {
    const lines: string[] = [
      `地番,${machiAzaName(machiAza)}`,
      `prc_num1,prc_num2,prc_num3,lng,lat`,
    ];
    for (const chiban of chibans) {
      lines.push(`${chiban.prc_num1},${chiban.prc_num2 || ''},${chiban.prc_num3 || ''},${chiban.point?.[0] || ''},${chiban.point?.[1] || ''}`);
    }
    outSections.push(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  }

  const createHeader = (iterations = 1): { iterations: number, data: HeaderRow[], buffer: Buffer } => {
    let header = '';
    const headerMaxSize = HEADER_CHUNK_SIZE * iterations;
    let lastBytePos = headerMaxSize;
    const headerData: HeaderRow[] = [];
    for (const [index, section] of outSections.entries()) {
      const ma = apiData[index].machiAza;

      header += `${machiAzaName(ma)},${lastBytePos},${section.length}\n`;
      headerData.push({
        name: machiAzaName(ma),
        offset: lastBytePos,
        length: section.length,
      });

      lastBytePos += section.length;
    }
    const headerBuf = Buffer.from(header + '=END=\n', 'utf8');
    if (headerBuf.length > headerMaxSize) {
      return createHeader(iterations + 1);
    } else {
      const padding = Buffer.alloc(headerMaxSize - headerBuf.length);
      padding.fill(0x20);
      return {
        iterations,
        data: headerData,
        buffer: Buffer.concat([headerBuf, padding])
      };
    }
  };

  const header = createHeader();
  return {
    headerIterations: header.iterations,
    headerData: header.data,
    data: Buffer.concat([header.buffer, ...outSections]),
  };
}

export async function outputChibanData(outDir: string, outFilename: string, apiData: ChibanApi) {
  if (apiData.length === 0) {
    return;
  }

  const outFileTXT = path.join(outDir, 'ja', outFilename + '-地番.txt');
  const txt = serializeApiDataTxt(apiData);
  await fs.promises.mkdir(path.dirname(outFileTXT), { recursive: true });
  await fs.promises.writeFile(outFileTXT, txt.data);

  console.log(`${outFilename}: ${apiData.length.toString(10).padEnd(4, ' ')} 件の町字の地番を出力した`);
}

export async function processCity(
  ma: MachiAzaData,
  machiAzaDataByCode: Map<string, MachiAzaData>,
  outDir: string,
): Promise<void> {
  let area = `${ma.pref} ${ma.county}${ma.city}`;
  if (ma.ward !== '') {
    area += ma.ward;
  }
  const searchQuery = `${area} 地番マスター`;
  const results = await getHubItemsByQuery(`${area} 地番マスター`, '市区町村レベル', ma.pref);
  const chibanDataRef = findResultByTypeAndArea(results.features, '地番マスター', area);
  const chibanPosDataRef = findResultByTypeAndArea(results.features, '地番マスター位置参照拡張', area);
  if (!chibanDataRef) {
    console.error(`Insufficient data found for ${searchQuery} (地番マスター)`);
    return;
  }

  const mainStream = getAndStreamCSVDataForId<ChibanData>(chibanDataRef.properties.id);
  const posStream = chibanPosDataRef ?
    getAndStreamCSVDataForId<ChibanPosData>(chibanPosDataRef.properties.id)
    :
    // 位置参照拡張データが無い場合もある
    (async function*() {})();

  const rawData = mergeDataLeftJoin(mainStream, posStream, ['lg_code', 'machiaza_id', 'prc_id'], true);

  let currentMachiAza: MachiAzaData | undefined = undefined;
  const apiData: ChibanApi = [];
  let currentChibanList: SingleChiban[] = [];
  for await (const raw of rawData) {
    const maEntry = machiAzaDataByCode.get(`${raw.lg_code}|${raw.machiaza_id}`);
    if (!maEntry) {
      continue;
    }
    if (currentMachiAza && (currentMachiAza.machiaza_id !== maEntry.machiaza_id || currentMachiAza.lg_code !== maEntry.lg_code)) {
      apiData.push({
        machiAza: rawToMachiAza(currentMachiAza),
        chibans: currentChibanList,
      });
      currentChibanList = [];
      currentMachiAza = maEntry;
    }
    if (!currentMachiAza) {
      currentMachiAza = maEntry;
    }

    currentChibanList.push({
      prc_num1: raw.prc_num1,
      prc_num2: raw.prc_num2 !== '' ? raw.prc_num2 : undefined,
      prc_num3: raw.prc_num3 !== '' ? raw.prc_num3 : undefined,
      point: 'rep_srid' in raw ? projectABRData(raw) : undefined,
    });
  }
  if (currentMachiAza && currentChibanList.length > 0) {
    apiData.push({
      machiAza: rawToMachiAza(currentMachiAza),
      chibans: currentChibanList,
    });
  }
  await outputChibanData(outDir, path.join(
    ma.pref,
    `${ma.county}${ma.city}${ma.ward}`,
  ), apiData);
}
```

- [ ] **Step 3: `04_make_chiban.ts` を `_lib` を使うように書き換え**

`src/processes/04_make_chiban.ts` を以下の内容に置き換える（コア処理はすべて `_lib` に移動済みなので、main 関数とそのヘルパだけ残す）:

```ts
#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import cliProgress from 'cli-progress';

import { getHubItemsByQuery, findResultByTypeAndArea, getAndParseCSVDataForId } from '../lib/hub.js';
import { MachiAzaData } from '../lib/abr_data/machi_aza.js';
import { processCity } from './04_make_chiban_lib.js';

const CONCURRENCY = parseInt(process.env.CHIBAN_CONCURRENCY ?? '4', 10);

async function main(argv: string[]) {
  const outDir = argv[2] || path.join(import.meta.dirname, '..', '..', 'out', 'api');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('事前準備: 町字データを取得中...');
  const machiAzaResults = await getHubItemsByQuery('町字マスター', '全国レベル');
  const machiAzaResult = findResultByTypeAndArea(machiAzaResults.features, '町字マスター', '全国');
  if (!machiAzaResult) {
    throw new Error(`「全国 町字マスター」データセットが見つかりませんでした`);
  }
  const machiAzaData = await getAndParseCSVDataForId<MachiAzaData>(machiAzaResult.properties.id);
  const machiAzaDataByCode = new Map(machiAzaData.map((ma) => [
    `${ma.lg_code}|${ma.machiaza_id}`,
    ma
  ]));

  // One representative entry per lg_code, in encounter order.
  const seenLgCodes = new Set<string>();
  const machiAzas: MachiAzaData[] = [];
  for (const ma of machiAzaData) {
    if (seenLgCodes.has(ma.lg_code)) continue;
    seenLgCodes.add(ma.lg_code);
    machiAzas.push(ma);
  }
  console.log('事前準備: 町字データを取得しました');

  const progress = new cliProgress.SingleBar({
    format: ' {bar} {percentage}% | ETA: {eta_formatted} | {value}/{total}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    etaBuffer: 30,
    fps: 2,
    noTTYOutput: true,
  });
  progress.start(machiAzas.length, 0);
  try {
    const executing = new Set<Promise<void>>();
    for (const ma of machiAzas) {
      const p: Promise<void> = processCity(ma, machiAzaDataByCode, outDir)
        .finally(() => {
          executing.delete(p);
          progress.increment();
        });
      executing.add(p);
      if (executing.size >= CONCURRENCY) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
  } finally {
    progress.stop();
  }
}

export default main;
```

- [ ] **Step 4: tsc で型エラーが無いことを確認**

Run: `npm run build:dev`
Expected: エラーなしで終了。

- [ ] **Step 5: lint を実行**

Run: `npm run lint`
Expected: エラーなしで終了。

- [ ] **Step 6: 04 のテストが引き続きパスすることを確認**

Run: `node --test --import tsx ./src/processes/04_make_chiban.test.ts`
Expected: `# pass 1` / `# fail 0`

- [ ] **Step 7: コミット**

```bash
git add src/processes/04_make_chiban_lib.ts src/processes/04_make_chiban.ts
git commit -m "Extract chiban shared logic to 04_make_chiban_lib"
```

---

## Task 3: `serializeApiDataTxt` のユニットテスト追加

**Files:**
- Create: `src/processes/04_make_chiban_lib.test.ts`

- [ ] **Step 1: テストファイルを作成**

新規ファイル `src/processes/04_make_chiban_lib.test.ts`:

```ts
import assert from 'node:assert';
import test, { describe } from 'node:test';

import { serializeApiDataTxt, HEADER_CHUNK_SIZE, type ChibanApi } from './04_make_chiban_lib.js';
import { SingleMachiAza } from '../data.js';

function ma(overrides: Partial<SingleMachiAza> = {}): SingleMachiAza {
  return {
    machiaza_id: '0001000',
    oaza_cho: '本町',
    chome: '',
    koaza: '',
    point: undefined,
    csv_ranges: undefined,
    ...overrides,
  };
}

await describe('serializeApiDataTxt', async () => {
  await test('returns empty-section header padded to HEADER_CHUNK_SIZE for empty input', () => {
    const result = serializeApiDataTxt([]);
    assert.equal(result.headerIterations, 1);
    assert.deepEqual(result.headerData, []);
    assert.equal(result.data.length, HEADER_CHUNK_SIZE);
    // ヘッダ末尾は =END=\n のみ
    assert.ok(result.data.toString('utf8', 0, 6).startsWith('=END=\n'));
  });

  await test('serializes a single machi-aza with one chiban', () => {
    const apiData: ChibanApi = [{
      machiAza: ma({ oaza_cho: '本町', chome: '1丁目' }),
      chibans: [{ prc_num1: '12', prc_num2: undefined, prc_num3: undefined, point: undefined }],
    }];
    const result = serializeApiDataTxt(apiData);
    assert.equal(result.headerIterations, 1);
    assert.equal(result.headerData.length, 1);
    assert.equal(result.headerData[0].name, '本町1丁目');
    // セクション本体は header の後ろに置かれる
    const sectionStart = result.headerData[0].offset;
    const sectionLen = result.headerData[0].length;
    const sectionText = result.data.toString('utf8', sectionStart, sectionStart + sectionLen);
    assert.ok(sectionText.includes('地番,本町1丁目\n'));
    assert.ok(sectionText.includes('prc_num1,prc_num2,prc_num3,lng,lat\n'));
    assert.ok(sectionText.includes('12,,,,\n'));
  });

  await test('serializes multiple machi-aza with sequential offsets', () => {
    const apiData: ChibanApi = [
      { machiAza: ma({ oaza_cho: '一丁目' }), chibans: [{ prc_num1: '1', prc_num2: undefined, prc_num3: undefined, point: undefined }] },
      { machiAza: ma({ oaza_cho: '二丁目' }), chibans: [{ prc_num1: '2', prc_num2: undefined, prc_num3: undefined, point: undefined }] },
    ];
    const result = serializeApiDataTxt(apiData);
    assert.equal(result.headerData.length, 2);
    // 2 つ目のオフセットは 1 つ目のオフセット + 1 つ目の長さ
    assert.equal(
      result.headerData[1].offset,
      result.headerData[0].offset + result.headerData[0].length,
    );
  });

  await test('expands header to multiple chunks when needed', () => {
    // 1 行あたり ~30 byte。`HEADER_CHUNK_SIZE = 50000` を超えるには ~2000 行必要
    const apiData: ChibanApi = [];
    for (let i = 0; i < 2500; i++) {
      apiData.push({
        machiAza: ma({ oaza_cho: `町${i}` }),
        chibans: [{ prc_num1: '1', prc_num2: undefined, prc_num3: undefined, point: undefined }],
      });
    }
    const result = serializeApiDataTxt(apiData);
    assert.ok(result.headerIterations >= 2, `expected >= 2 iterations, got ${result.headerIterations}`);
    // 全 entry のオフセットがヘッダ領域の外を指している
    const headerMaxSize = HEADER_CHUNK_SIZE * result.headerIterations;
    for (const row of result.headerData) {
      assert.ok(row.offset >= headerMaxSize, `offset ${row.offset} should be >= ${headerMaxSize}`);
    }
  });
});
```

注: `SingleMachiAza` の最小フィールドのみ ma() で生成している。実フィールド数が増えたら type assertion でカバーする必要があるが、現状の data.ts の型定義に合わせる。

- [ ] **Step 2: テストを実行してパスを確認**

Run: `node --test --import tsx ./src/processes/04_make_chiban_lib.test.ts`
Expected: `# pass 4` / `# fail 0`

もし `SingleMachiAza` の必須プロパティが ma() のデフォルト値に足りずに型エラーが出る場合、`data.ts` の `SingleMachiAza` 定義を確認し、不足プロパティを追加する。

- [ ] **Step 3: lint を実行**

Run: `npm run lint`
Expected: エラーなしで終了。

- [ ] **Step 4: コミット**

```bash
git add src/processes/04_make_chiban_lib.test.ts
git commit -m "Add unit tests for serializeApiDataTxt"
```

---

## Task 4: worker entry ファイルを作成

**Files:**
- Create: `src/processes/04_make_chiban_worker.ts`

- [ ] **Step 1: worker ファイルを作成**

新規ファイル `src/processes/04_make_chiban_worker.ts`:

```ts
import workerpool from 'workerpool';

import { getAndStreamCSVDataForId } from '../lib/hub.js';
import { MachiAzaData } from '../lib/abr_data/machi_aza.js';
import { processCity } from './04_make_chiban_lib.js';

type ProcessCityArgs = {
  ma: MachiAzaData;
  machiAzaResultId: string;
  outDir: string;
};

let machiAzaByLgCodeCache: Map<string, MachiAzaData[]> | undefined;

async function loadMachiAzaIndex(id: string): Promise<Map<string, MachiAzaData[]>> {
  if (machiAzaByLgCodeCache) return machiAzaByLgCodeCache;
  const stream = getAndStreamCSVDataForId<MachiAzaData>(id);
  const index = new Map<string, MachiAzaData[]>();
  for await (const row of stream) {
    const list = index.get(row.lg_code) ?? [];
    list.push(row);
    index.set(row.lg_code, list);
  }
  machiAzaByLgCodeCache = index;
  return index;
}

async function processCityForWorker(args: ProcessCityArgs): Promise<void> {
  const index = await loadMachiAzaIndex(args.machiAzaResultId);
  const entries = index.get(args.ma.lg_code) ?? [];
  const machiAzaDataByCode = new Map(
    entries.map((ma) => [`${ma.lg_code}|${ma.machiaza_id}`, ma]),
  );
  await processCity(args.ma, machiAzaDataByCode, args.outDir);
}

workerpool.worker({
  processCity: processCityForWorker,
});
```

- [ ] **Step 2: tsx でロード可能か smoke test**

Run: `node --import tsx -e "import('./src/processes/04_make_chiban_worker.ts').then(() => console.log('ok')).catch(e => { console.error(e); process.exit(1); })"`
Expected output: `ok`（プロセスがハングする場合は `workerpool.worker()` の登録が成功して standby に入っている。Ctrl-C で中断して良い。エラー出力が無ければ成功扱い）

注: `workerpool.worker()` は呼ばれた時点で IPC で待機状態に入る。スクリプト単体で実行すると終わらないことに注意。`ok` が出る前に standby に入る可能性があるので、エラー無く `workerpool.worker is not a function` 等が出ないことを確認できれば OK。

代替の smoke test として、tsc でコンパイル可能であることを確認:

Run: `npm run build:dev`
Expected: エラーなしで終了。

- [ ] **Step 3: lint を実行**

Run: `npm run lint`
Expected: エラーなしで終了。

- [ ] **Step 4: コミット**

```bash
git add src/processes/04_make_chiban_worker.ts
git commit -m "Add workerpool worker entry for chiban city processing"
```

---

## Task 5: `runCitiesWithPromiseRace` を関数として抽出（リファクタのみ）

このタスクは挙動を変えない。env 分岐の足場を整える。

**Files:**
- Modify: `src/processes/04_make_chiban.ts`

- [ ] **Step 1: 関数抽出**

`src/processes/04_make_chiban.ts` の `main()` 内にある Promise.race ベースの並列ループを、新規ヘルパ関数に切り出す。

ファイル全体は以下のようになる（差分: Promise.race のループを `runCitiesWithPromiseRace` に切り出し、main から呼ぶ）:

```ts
#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import cliProgress from 'cli-progress';

import { getHubItemsByQuery, findResultByTypeAndArea, getAndParseCSVDataForId } from '../lib/hub.js';
import { MachiAzaData } from '../lib/abr_data/machi_aza.js';
import { processCity } from './04_make_chiban_lib.js';

const CONCURRENCY = parseInt(process.env.CHIBAN_CONCURRENCY ?? '4', 10);

async function runCitiesWithPromiseRace(
  machiAzas: MachiAzaData[],
  machiAzaDataByCode: Map<string, MachiAzaData>,
  outDir: string,
  progress: cliProgress.SingleBar,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const ma of machiAzas) {
    const p: Promise<void> = processCity(ma, machiAzaDataByCode, outDir)
      .finally(() => {
        executing.delete(p);
        progress.increment();
      });
    executing.add(p);
    if (executing.size >= CONCURRENCY) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

async function main(argv: string[]) {
  const outDir = argv[2] || path.join(import.meta.dirname, '..', '..', 'out', 'api');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('事前準備: 町字データを取得中...');
  const machiAzaResults = await getHubItemsByQuery('町字マスター', '全国レベル');
  const machiAzaResult = findResultByTypeAndArea(machiAzaResults.features, '町字マスター', '全国');
  if (!machiAzaResult) {
    throw new Error(`「全国 町字マスター」データセットが見つかりませんでした`);
  }
  const machiAzaData = await getAndParseCSVDataForId<MachiAzaData>(machiAzaResult.properties.id);
  const machiAzaDataByCode = new Map(machiAzaData.map((ma) => [
    `${ma.lg_code}|${ma.machiaza_id}`,
    ma
  ]));

  const seenLgCodes = new Set<string>();
  const machiAzas: MachiAzaData[] = [];
  for (const ma of machiAzaData) {
    if (seenLgCodes.has(ma.lg_code)) continue;
    seenLgCodes.add(ma.lg_code);
    machiAzas.push(ma);
  }
  console.log('事前準備: 町字データを取得しました');

  const progress = new cliProgress.SingleBar({
    format: ' {bar} {percentage}% | ETA: {eta_formatted} | {value}/{total}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    etaBuffer: 30,
    fps: 2,
    noTTYOutput: true,
  });
  progress.start(machiAzas.length, 0);
  try {
    await runCitiesWithPromiseRace(machiAzas, machiAzaDataByCode, outDir, progress);
  } finally {
    progress.stop();
  }
}

export default main;
```

- [ ] **Step 2: 04 のテストが引き続きパスすることを確認**

Run: `node --test --import tsx ./src/processes/04_make_chiban.test.ts`
Expected: `# pass 1` / `# fail 0`

- [ ] **Step 3: コミット**

```bash
git add src/processes/04_make_chiban.ts
git commit -m "Extract runCitiesWithPromiseRace helper from main"
```

---

## Task 6: workerpool 版ディスパッチャを追加

env による分岐と workerpool 版実装を追加。

**Files:**
- Modify: `src/processes/04_make_chiban.ts`

- [ ] **Step 1: workerpool 用ヘルパと env 分岐を追加**

`src/processes/04_make_chiban.ts` を以下に置き換える（既存の Promise.race ヘルパは維持しつつ、workerpool ヘルパと env 分岐を追加）:

```ts
#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import cliProgress from 'cli-progress';
import workerpool from 'workerpool';

import { getHubItemsByQuery, findResultByTypeAndArea, getAndParseCSVDataForId } from '../lib/hub.js';
import { MachiAzaData } from '../lib/abr_data/machi_aza.js';
import { processCity } from './04_make_chiban_lib.js';

const CONCURRENCY = parseInt(process.env.CHIBAN_CONCURRENCY ?? '4', 10);
const PARALLEL_MODE = process.env.CHIBAN_PARALLEL ?? '';

async function runCitiesWithPromiseRace(
  machiAzas: MachiAzaData[],
  machiAzaDataByCode: Map<string, MachiAzaData>,
  outDir: string,
  progress: cliProgress.SingleBar,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const ma of machiAzas) {
    const p: Promise<void> = processCity(ma, machiAzaDataByCode, outDir)
      .finally(() => {
        executing.delete(p);
        progress.increment();
      });
    executing.add(p);
    if (executing.size >= CONCURRENCY) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

async function runCitiesWithWorkerpool(
  machiAzas: MachiAzaData[],
  machiAzaResultId: string,
  outDir: string,
  progress: cliProgress.SingleBar,
): Promise<void> {
  const workerPath = path.join(import.meta.dirname, '04_make_chiban_worker.ts');
  const pool = workerpool.pool(workerPath, {
    workerType: 'process',
    maxWorkers: CONCURRENCY,
    forkOpts: { execArgv: ['--import', 'tsx'] },
  });
  try {
    await Promise.all(machiAzas.map(async (ma) => {
      try {
        await pool.exec('processCity', [{ ma, machiAzaResultId, outDir }]);
      } catch (err) {
        console.error(
          `Failed to process ${ma.pref} ${ma.county}${ma.city}${ma.ward}:`,
          err,
        );
      } finally {
        progress.increment();
      }
    }));
  } finally {
    await pool.terminate({ force: true });
  }
}

async function main(argv: string[]) {
  const outDir = argv[2] || path.join(import.meta.dirname, '..', '..', 'out', 'api');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('事前準備: 町字データを取得中...');
  const machiAzaResults = await getHubItemsByQuery('町字マスター', '全国レベル');
  const machiAzaResult = findResultByTypeAndArea(machiAzaResults.features, '町字マスター', '全国');
  if (!machiAzaResult) {
    throw new Error(`「全国 町字マスター」データセットが見つかりませんでした`);
  }
  const machiAzaResultId = machiAzaResult.properties.id;
  const machiAzaData = await getAndParseCSVDataForId<MachiAzaData>(machiAzaResultId);
  const machiAzaDataByCode = new Map(machiAzaData.map((ma) => [
    `${ma.lg_code}|${ma.machiaza_id}`,
    ma
  ]));

  const seenLgCodes = new Set<string>();
  const machiAzas: MachiAzaData[] = [];
  for (const ma of machiAzaData) {
    if (seenLgCodes.has(ma.lg_code)) continue;
    seenLgCodes.add(ma.lg_code);
    machiAzas.push(ma);
  }
  console.log('事前準備: 町字データを取得しました');

  const progress = new cliProgress.SingleBar({
    format: ' {bar} {percentage}% | ETA: {eta_formatted} | {value}/{total}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    etaBuffer: 30,
    fps: 2,
    noTTYOutput: true,
  });
  progress.start(machiAzas.length, 0);
  try {
    if (PARALLEL_MODE === 'workerpool') {
      console.log(`並列モード: workerpool process (maxWorkers=${CONCURRENCY})`);
      await runCitiesWithWorkerpool(machiAzas, machiAzaResultId, outDir, progress);
    } else {
      console.log(`並列モード: Promise.race (concurrency=${CONCURRENCY})`);
      await runCitiesWithPromiseRace(machiAzas, machiAzaDataByCode, outDir, progress);
    }
  } finally {
    progress.stop();
  }
}

export default main;
```

- [ ] **Step 2: tsc + lint**

Run: `npm run build:dev`
Expected: エラーなしで終了。

Run: `npm run lint`
Expected: エラーなしで終了。

- [ ] **Step 3: 既存テストが引き続きパスすることを確認（Promise.race パス）**

Run: `node --test --import tsx ./src/processes/04_make_chiban.test.ts`
Expected: `# pass 1` / `# fail 0`

このテストは `CHIBAN_PARALLEL` 未設定で動くため、Promise.race パスが選ばれる。

- [ ] **Step 4: コミット**

```bash
git add src/processes/04_make_chiban.ts
git commit -m "Add workerpool process-mode dispatcher behind CHIBAN_PARALLEL env"
```

---

## Task 7: npm スクリプトを追加

**Files:**
- Modify: `package.json`

- [ ] **Step 1: スクリプト行を追加**

`package.json` の `scripts` セクション内、`"run:04_make_chiban"` の直後に新規エントリを挿入する。

修正後の該当箇所:

```json
"run:04_make_chiban": "node --max-old-space-size=8192 --import tsx ./src/04_make_chiban.ts",
"run:04_make_chiban:pool": "CHIBAN_PARALLEL=workerpool node --max-old-space-size=8192 --import tsx ./src/04_make_chiban.ts",
```

注: macOS の `npm run` は `CHIBAN_PARALLEL=workerpool ...` 形式の env プレフィックスをサポートする（標準的な POSIX 動作）。

- [ ] **Step 2: workerpool バリアントが実際に worker プロセスを spawn することを smoke test**

最小スコープ（屋久島町、lg_code 465054）で実行:

```bash
SETTINGS_JSON='{"lgCodes":["465054"]}' npm run run:04_make_chiban:pool -- ./out/api_smoke
```

Expected:
- `並列モード: workerpool process (maxWorkers=4)` のログが出る
- `鹿児島県/熊毛郡屋久島町: ... 件の町字の地番を出力した` のログが出る
- exit code 0
- `out/api_smoke/ja/鹿児島県/熊毛郡屋久島町-地番.txt` が生成される

別ターミナル（実行中に）で `ps -ef | grep node | grep -v grep | wc -l` を見ると、worker プロセスが立っていることが確認できる（最低 1 個、最大 4 個）。

- [ ] **Step 3: 後始末**

```bash
rm -rf ./out/api_smoke
```

- [ ] **Step 4: コミット**

```bash
git add package.json
git commit -m "Add run:04_make_chiban:pool npm script for workerpool variant"
```

---

## Task 8: 同値性検証（手動）

このタスクは新規コードを書かない。両実装の出力がバイナリ一致することを確認する。

**事前条件:** `npm run run:01_make_prefecture_city` と `npm run run:02_make_machi_aza` が事前に走っている（cache/ と out/api 配下の前段階データが揃っている）こと。すでに揃っていればそのまま進める。

- [ ] **Step 1: 既存（Promise.race）版で出力**

```bash
rm -rf ./out/api_baseline
SETTINGS_JSON='{"lgCodes":["^26"]}' npm run run:04_make_chiban -- ./out/api_baseline
```

`^26` は京都府の lg_code 接頭辞。30 分以内に終わる程度のサイズ。Expected: exit 0。

- [ ] **Step 2: workerpool 版で出力**

```bash
rm -rf ./out/api_workerpool
SETTINGS_JSON='{"lgCodes":["^26"]}' npm run run:04_make_chiban:pool -- ./out/api_workerpool
```

Expected: exit 0。

- [ ] **Step 3: バイナリ一致を sha256 で確認**

```bash
( cd ./out/api_baseline && find . -name '*-地番.txt' -print0 | sort -z | xargs -0 shasum -a 256 ) > /tmp/baseline.sha256
( cd ./out/api_workerpool && find . -name '*-地番.txt' -print0 | sort -z | xargs -0 shasum -a 256 ) > /tmp/workerpool.sha256
diff /tmp/baseline.sha256 /tmp/workerpool.sha256
```

Expected: diff 出力なし（exit 0）。差分が出る場合は本タスク失敗。原因調査が必要（serializeApiDataTxt の決定性、processCity の入力順序、proj4 投影の決定性などを再確認）。

- [ ] **Step 4: 検証結果を記録**

`docs/superpowers/specs/2026-05-21-workerpool-process-mode-design.md` の末尾に検証結果セクションを追記:

```markdown

## 検証結果（2026-05-21 京都府スコープ）

- 同値性: PASS / FAIL（実測結果）
- baseline ファイル数: N
- workerpool ファイル数: N
- sha256 一致率: 100% / その他
```

実測値で埋める。

- [ ] **Step 5: 後始末 + コミット**

```bash
rm -rf ./out/api_baseline ./out/api_workerpool
git add docs/superpowers/specs/2026-05-21-workerpool-process-mode-design.md
git commit -m "Record workerpool equivalence verification result for 京都府"
```

---

## Task 9: ベンチマーク（手動・任意）

性能差を実測する。失敗しても本実装の正しさには影響しないが、採用判断の材料になる。

- [ ] **Step 1: 両実装で時間とメモリを測定**

macOS の `/usr/bin/time -l` を使う:

```bash
rm -rf ./out/api_bench_baseline
/usr/bin/time -l env SETTINGS_JSON='{"lgCodes":["^26"]}' npm run run:04_make_chiban -- ./out/api_bench_baseline 2>&1 | tee /tmp/bench_baseline.log

rm -rf ./out/api_bench_workerpool
/usr/bin/time -l env SETTINGS_JSON='{"lgCodes":["^26"]}' npm run run:04_make_chiban:pool -- ./out/api_bench_workerpool 2>&1 | tee /tmp/bench_workerpool.log
```

- [ ] **Step 2: 並列数の探索**

```bash
for n in 1 2 4 8; do
  rm -rf ./out/api_bench_n$n
  echo "=== N=$n ==="
  /usr/bin/time -l env CHIBAN_CONCURRENCY=$n SETTINGS_JSON='{"lgCodes":["^26"]}' npm run run:04_make_chiban:pool -- ./out/api_bench_n$n 2>&1 | tail -10
done
```

- [ ] **Step 3: 結果を spec の検証結果セクションに追記**

`docs/superpowers/specs/2026-05-21-workerpool-process-mode-design.md` に以下を追記:

```markdown

### ベンチマーク（京都府、N=1,2,4,8）

| 実装 | N | wall time | maximum RSS | user time | sys time |
|---|---|---|---|---|---|
| Promise.race | 4 | ... | ... | ... | ... |
| workerpool | 1 | ... | ... | ... | ... |
| workerpool | 2 | ... | ... | ... | ... |
| workerpool | 4 | ... | ... | ... | ... |
| workerpool | 8 | ... | ... | ... | ... |

考察: ...
```

実測値で埋める。

- [ ] **Step 4: 後始末 + コミット**

```bash
rm -rf ./out/api_bench_*
git add docs/superpowers/specs/2026-05-21-workerpool-process-mode-design.md
git commit -m "Record workerpool benchmark results for 京都府"
```

---

## 全体完了条件

- すべてのタスクのチェックボックスが埋まっている
- `npm run build:dev` がエラー無し
- `npm run lint` がエラー無し
- `node --test --import tsx ./src/processes/04_make_chiban.test.ts` がパス
- `node --test --import tsx ./src/processes/04_make_chiban_lib.test.ts` がパス
- `npm test` の失敗件数が開始時と同じ 1 件（宮崎県えびの市の既知の失敗のみ）であること
- Task 8 の同値性検証が PASS
- ブランチ `chiban-workerpool-process-mode` に上記のコミット群が積まれている
