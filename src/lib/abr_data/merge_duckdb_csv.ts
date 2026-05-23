import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getDownloadStream } from '../fetch_tools.js';
import { getUrlForCSVResource, type HubSearchResult } from '../hub.js';
import { loadSettings } from '../settings.js';
import { unzipToFiles } from '../zip_tools.js';
import type { RsdtdspRsdtDataWithPos } from './rsdtdsp_rsdt.js';

/**
 * settings.lgCodes (RegExp[]) を DuckDB SQL の WHERE 断片に変換する純関数。
 * 空配列なら undefined を返し、呼び出し側で WHERE 句自体を省略させる。
 * RegExp.source 内のシングルクォートは SQL リテラル境界を破壊するので
 * 二重化 ('') してエスケープする (信頼境界外入力扱い)。
 */
export function buildLgCodeWhereClause(
  columnExpr: string,
  patterns: RegExp[],
): string | undefined {
  if (patterns.length === 0) return undefined;
  return patterns
    .map((re) => {
      const escaped = re.source.replace(/'/g, "''");
      return `regexp_matches(${columnExpr}, '${escaped}')`;
    })
    .join(' OR ');
}

type CsvRow = Record<string, string | null>;

export interface MergeJoinOpts {
  mainDir: string;
  posDir: string;
  lgCodePatterns: RegExp[];
  /** DuckDB DB ファイルを置く temp ルート。省略時は os.tmpdir() に mkdtemp。 */
  tempRoot?: string;
}

const JOIN_KEYS = ['lg_code', 'machiaza_id', 'blk_id', 'rsdt_id', 'rsdt2_id'] as const;
const OVERRIDE_COLS = ['rsdt_addr_flg', 'rsdt_addr_mtd_code', 'basic_rsdt_div'] as const;

/**
 * 2 つの CSV ディレクトリを DuckDB read_csv_auto で並列スキャンし、
 * LEFT JOIN + COALESCE 上書き + lgCode push-down + ORDER BY で yield する。
 *
 * 入出力は純粋に CSV ディレクトリ ↔ AsyncIterable なので、Hub や ZIP の
 * 知識は持たない (公開 API が wrap する)。
 */
export async function* mergeJoinFromCsvDirs(
  opts: MergeJoinOpts,
): AsyncIterableIterator<CsvRow> {
  const tempRoot = opts.tempRoot ?? os.tmpdir();
  const dbDir = await fs.mkdtemp(path.join(tempRoot, 'merge-duckdb-csv-'));
  const dbPath = path.join(dbDir, 'db.duckdb');
  const spillDir = path.join(dbDir, 'duckdb-spill');
  await fs.mkdir(spillDir, { recursive: true });

  let instance: DuckDBInstance | undefined;
  let connection: DuckDBConnection | undefined;
  try {
    instance = await DuckDBInstance.create(dbPath);
    connection = await instance.connect();

    const threads = Math.max(1, os.cpus().length);
    const memoryGb = Math.max(2, threads * 3);
    await connection.run(`SET threads = ${threads}`);
    await connection.run('SET preserve_insertion_order = false');
    await connection.run(`SET temp_directory = '${spillDir.replace(/'/g, "''")}'`);
    await connection.run(`PRAGMA memory_limit = '${memoryGb}GB'`);

    const mainGlob = path.join(opts.mainDir, '*.csv').replace(/'/g, "''");
    const posGlob  = path.join(opts.posDir,  '*.csv').replace(/'/g, "''");
    await connection.run(
      `CREATE VIEW l AS SELECT * FROM read_csv_auto('${mainGlob}', header=true, parallel=true, all_varchar=true)`,
    );
    await connection.run(
      `CREATE VIEW r AS SELECT * FROM read_csv_auto('${posGlob}',  header=true, parallel=true, all_varchar=true)`,
    );

    const where = buildLgCodeWhereClause('l.lg_code', opts.lgCodePatterns);
    const replaceClause = OVERRIDE_COLS
      .map((c) => `COALESCE(r.${c}, l.${c}) AS ${c}`)
      .join(', ');
    // CSV の空 trailing フィールド (例: rsdt2_id) は read_csv_auto により NULL になる。
    // 標準 SQL JOIN USING / = は NULL=NULL を false 扱いするため、JOIN キーに 1 つでも
    // NULL があると全行ミスヒットになる。IS NOT DISTINCT FROM で NULL-safe に比較する。
    const onClause = JOIN_KEYS
      .map((k) => `l.${k} IS NOT DISTINCT FROM r.${k}`)
      .join(' AND ');
    // SQLite 経路 (merge_sqlite.ts) は key カラムを文字列連結してから ORDER BY するため、
    // 空フィールドは '' として他より小さい順序になる。DuckDB の multi-column ORDER BY 既定は
    // NULLS LAST なので、何もしないと NULL を含む row が後ろに来てバイト同一性が崩れる。
    // COALESCE で NULL を '' に正規化して、SQLite と同じ順序を再現する。
    const orderClause = JOIN_KEYS.map((k) => `COALESCE(l.${k}, '')`).join(', ');
    const sql = `
      SELECT
        l.* REPLACE (${replaceClause}),
        r.rep_lon, r.rep_lat, r.rep_srid, r.rep_scale, r.rep_src_code,
        r.rsdt_addr_code_rdbl, r.rsdt_addr_data_mnt_date
      FROM l LEFT JOIN r ON ${onClause}
      ${where ? `WHERE ${where}` : ''}
      ORDER BY ${orderClause}
    `;

    const result = await connection.stream(sql);
    for await (const rowObjects of result.yieldRowObjects()) {
      for (const row of rowObjects) {
        yield row as CsvRow;
      }
    }
  } finally {
    try { connection?.closeSync(); } catch { /* ignore */ }
    try { instance?.closeSync(); }   catch { /* ignore */ }
    await fs.rm(dbDir, { recursive: true, force: true }).catch((e: unknown) => {
      console.warn(`merge_duckdb_csv: temp cleanup failed: ${dbDir}`, e);
    });
  }
}

async function extractGroupToTemp(
  hubResults: HubSearchResult[],
  subDir: string,
  rootDir: string,
): Promise<string> {
  const outDir = path.join(rootDir, subDir);
  await fs.mkdir(outDir, { recursive: true });
  await Promise.all(hubResults.map(async (res, i) => {
    const url = getUrlForCSVResource(res);
    if (!url) throw new Error(`mergeRsdtdspRsdtDataDuckdbCsv: no CSV URL on HubSearchResult #${i}`);
    const buffer = await getDownloadStream(url);
    // unzipToFiles は同一 outDir に複数 ZIP を展開しても衝突回避するので
    // 並列で同じ outDir に書き込んで問題ない (ファイル名連番化で de-collide)。
    await unzipToFiles(buffer, outDir);
  }));
  return outDir;
}

/**
 * main/pos の HubSearchResult 配列を受け、ZIP を temp に展開して
 * mergeJoinFromCsvDirs にディレクトリパスを渡す。終了時に temp を削除する。
 */
export async function* mergeRsdtdspRsdtDataDuckdbCsv(
  mainHubResults: HubSearchResult[],
  posHubResults:  HubSearchResult[],
): AsyncIterableIterator<RsdtdspRsdtDataWithPos> {
  const settings = await loadSettings();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-rsdt-duckdb-csv-'));
  try {
    const [mainDir, posDir] = await Promise.all([
      extractGroupToTemp(mainHubResults, 'main', tempRoot),
      extractGroupToTemp(posHubResults,  'pos',  tempRoot),
    ]);
    for await (const row of mergeJoinFromCsvDirs({
      mainDir,
      posDir,
      lgCodePatterns: settings.lgCodes,
      tempRoot,
    })) {
      yield row as unknown as RsdtdspRsdtDataWithPos;
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch((e: unknown) => {
      console.warn(`mergeRsdtdspRsdtDataDuckdbCsv: temp cleanup failed: ${tempRoot}`, e);
    });
  }
}
