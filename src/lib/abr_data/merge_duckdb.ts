import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _createKey(data: any, keys: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return keys.map((key) => `${data[key]}`).join("|");
}

async function _appendStream<T>(
  connection: DuckDBConnection,
  table: string,
  source: AsyncIterableIterator<T>,
  keys: string[],
): Promise<void> {
  const appender = await connection.createAppender(table);
  for await (const data of source) {
    appender.appendVarchar(_createKey(data, keys));
    appender.appendVarchar(JSON.stringify(data));
    appender.endRow();
  }
  appender.closeSync();
}

export async function *mergeDataLeftJoinDuckdb<T, U>(
  left: AsyncIterableIterator<T>,
  right: AsyncIterableIterator<U>,
  keys: string[],
  memory: boolean = false,
): AsyncIterableIterator<T | (T & U)> {
  let tmpDbPath = ":memory:";
  let tmpDir: string | undefined;

  if (!memory) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "merge-data-left-join-duckdb-"));
    tmpDbPath = path.join(tmpDir, "db.duckdb");
    console.log(`Creating temporary database: ${tmpDbPath}`);
  }

  const instance = await DuckDBInstance.create(tmpDbPath);
  const connection = await instance.connect();
  try {
    await connection.run("PRAGMA memory_limit='6GB'");
    await connection.run(`CREATE TABLE l (key VARCHAR, data JSON)`);
    await connection.run(`CREATE TABLE r (key VARCHAR, data JSON)`);

    await Promise.all([
      _appendStream(connection, "l", left, keys),
      _appendStream(connection, "r", right, keys),
    ]);

    // Use connection.stream() which returns a DuckDBResult supporting streaming.
    // yieldRowObjects() is an AsyncIterableIterator that yields Record<string, DuckDBValue>[]
    // (one array of row-objects per fetched chunk), so we iterate chunks then rows.
    // ORDER BY l.key is required for callers that assume rows arrive grouped by lg_code
    // (see merge_sqlite.ts for the same reasoning).
    const result = await connection.stream(`
      SELECT json_merge_patch(l.data, COALESCE(r.data, '{}'::JSON)) AS d01
      FROM l LEFT JOIN r ON l.key = r.key
      ORDER BY l.key
    `);
    for await (const rowObjects of result.yieldRowObjects()) {
      for (const row of rowObjects) {
        yield JSON.parse(row.d01 as string) as T | (T & U);
      }
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true });
    }
  }
}
