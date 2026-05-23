import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getDownloadStream } from '../fetch_tools.js';
import { getUrlForCSVResource, type HubSearchResult } from '../hub.js';
import { unzipToFiles } from '../zip_tools.js';
import type { ChibanDataWithPos } from './chiban.js';

export type ChibanDuckdbLifecycle = 'shared' | 'percity';

export interface ChibanDuckdbCtx {
  lifecycle: ChibanDuckdbLifecycle;
  instance?: DuckDBInstance;
  tempRoot: string;
}

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
  // 初期化途中で throw した場合、呼び出し側は ctx を受け取らないため
  // closeChibanDuckdbCtx を呼べない。ここで instance / tempRoot を片付ける。
  let instance: DuckDBInstance | undefined;
  try {
    instance = await DuckDBInstance.create(dbPath);
    const setup = await instance.connect();
    try {
      await configureDuckdbConnection(setup, spillDir);
    } finally {
      setup.closeSync();
    }
    return { lifecycle, instance, tempRoot };
  } catch (e) {
    try { instance?.closeSync(); } catch { /* ignore */ }
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { /* ignore */ });
    throw e;
  }
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
      `mergeChibanDataDuckdbCsv: cannot extract lg_code from URL "${url}" (expected /(\\d{6})_csv_zip$/) — check lg_code`,
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
 * ctx.lifecycle が 'shared' のときは ctx.instance を使い回し、
 * city-<lg_code>/ の cleanup は closeChibanDuckdbCtx に委ねる。
 * 'percity' のときは 1 自治体ごとに instance を作成・破棄する。
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
