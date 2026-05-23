import { mergeDataLeftJoinSqlite } from "./merge_sqlite.js";
import { mergeDataLeftJoinDuckdb } from "./merge_duckdb.js";

export { mergeDataLeftJoinSqlite } from "./merge_sqlite.js";
export { mergeDataLeftJoinDuckdb } from "./merge_duckdb.js";

export async function *mergeDataLeftJoin<T, U>(
  left: AsyncIterableIterator<T>,
  right: AsyncIterableIterator<U>,
  keys: string[],
  memory: boolean = false,
): AsyncIterableIterator<T | (T & U)> {
  const backend = process.env.MERGE_BACKEND === "duckdb" ? "duckdb" : "sqlite";
  const impl = backend === "duckdb" ? mergeDataLeftJoinDuckdb : mergeDataLeftJoinSqlite;
  yield* impl(left, right, keys, memory);
}
