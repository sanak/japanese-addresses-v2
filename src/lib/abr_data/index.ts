import { mergeDataLeftJoinSqlite } from "./merge_sqlite.js";
import { mergeDataLeftJoinDuckdb } from "./merge_duckdb.js";

export { mergeDataLeftJoinSqlite } from "./merge_sqlite.js";
export { mergeDataLeftJoinDuckdb } from "./merge_duckdb.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _createKey(data: any, keys: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return keys.map((key) => `${data[key]}`).join("|");
}

export async function *mergeDataLeftJoin<T, U>(
  left: AsyncIterableIterator<T>,
  right: AsyncIterableIterator<U>,
  keys: string[],
  memory: boolean = false,
): AsyncIterableIterator<T | (T & U)> {
  if (memory) {
    // Fast path: load right side into a Map then stream left, avoiding the
    // SQLite/DuckDB backend and JSON round-trips entirely. Yields rows in
    // left-input order, which is what callers (04_make_chiban) rely on.
    const rightMap = new Map<string, U>();
    for await (const data of right) {
      rightMap.set(_createKey(data, keys), data);
    }
    for await (const data of left) {
      const rightData = rightMap.get(_createKey(data, keys));
      yield (rightData !== undefined
        ? Object.assign({}, data, rightData)
        : data) as T | (T & U);
    }
    return;
  }

  const backend = process.env.MERGE_BACKEND === "duckdb" ? "duckdb" : "sqlite";
  const impl = backend === "duckdb" ? mergeDataLeftJoinDuckdb : mergeDataLeftJoinSqlite;
  yield* impl(left, right, keys, memory);
}
