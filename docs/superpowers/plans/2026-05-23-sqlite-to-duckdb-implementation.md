# SQLite → DuckDB 置換と性能検証 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mergeDataLeftJoin` の SQLite 実装と並行して DuckDB 実装を追加し、env 変数 `MERGE_BACKEND=duckdb` で切替可能にしたうえで、京都府・北海道データに対する 4 指標 (wall time / peak RSS / 出力 byte 一致 / 依存サイズ) のベンチマーク結果を残す。

**Architecture:** `src/lib/abr_data/index.ts` を薄い dispatcher にし、SQLite 実装を `merge_sqlite.ts` に、DuckDB 実装を `merge_duckdb.ts` に分離。呼び出し元 (02/03/04) は一切変更しない。テストは両バックエンドの matrix。

**Tech Stack:** Node.js 22 / TypeScript / tsx / Node.js built-in test runner / `better-sqlite3` (既存) / `@duckdb/node-api` (新規) / Bash + `/usr/bin/time -l` でベンチ。

**Spec参照:** `docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-design.md`

---

## Task 1: `@duckdb/node-api` の導入と API smoke test

DuckDB バインディングのインストールと、後続タスクで使う API パターン (DuckDBInstance / Connection / Appender / json_merge_patch / stream) が動くことを最初に検証する。

**Files:**
- Modify: `package.json` (devDependencies に `@duckdb/node-api` 追加)
- Create: `src/lib/abr_data/duckdb_smoke.test.ts`

- [ ] **Step 1: 最新版を確認してインストール**

`@duckdb/node-api` の最新安定版を npm registry で確認 (ユーザー memory feedback `latest_dep_versions` に従い、過去の固定版でなく最新版を採用)。

```bash
npm view @duckdb/node-api version
# 出力された安定版を採用
npm install --save-dev @duckdb/node-api
```

Expected: `package.json` の `devDependencies` に `"@duckdb/node-api": "^<version>"` が追加され、`package-lock.json` が更新される。

- [ ] **Step 2: smoke テストを書く (失敗する状態)**

```ts
// src/lib/abr_data/duckdb_smoke.test.ts
import assert from 'node:assert';
import test, { describe } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';

await describe('@duckdb/node-api smoke', async () => {
  await test('SELECT works', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const reader = await connection.runAndReadAll('SELECT 42 AS x');
    const rows = reader.getRowObjects();
    assert.deepStrictEqual(rows, [{ x: 42n }]); // DuckDB returns BIGINT as bigint
    connection.closeSync();
    instance.closeSync();
  });

  await test('json_merge_patch works', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const reader = await connection.runAndReadAll(
      `SELECT json_merge_patch('{"a":1,"b":2}'::JSON, '{"b":3,"c":4}'::JSON) AS merged`
    );
    const rows = reader.getRowObjects();
    // json_merge_patch は JSON 文字列を返す
    assert.strictEqual(JSON.parse(rows[0].merged as string).a, 1);
    assert.strictEqual(JSON.parse(rows[0].merged as string).b, 3);
    assert.strictEqual(JSON.parse(rows[0].merged as string).c, 4);
    connection.closeSync();
    instance.closeSync();
  });

  await test('Appender works for VARCHAR + JSON', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    await connection.run('CREATE TABLE t (key VARCHAR, data JSON)');
    const appender = await connection.createAppender('t');
    appender.appendVarchar('k1');
    appender.appendVarchar('{"a":1}');
    appender.endRow();
    appender.appendVarchar('k2');
    appender.appendVarchar('{"b":2}');
    appender.endRow();
    appender.closeSync();

    const reader = await connection.runAndReadAll('SELECT key, data FROM t ORDER BY key');
    const rows = reader.getRowObjects();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].key, 'k1');
    connection.closeSync();
    instance.closeSync();
  });
});
```

- [ ] **Step 3: smoke テストを実行して API シグネチャを確認**

```bash
node --test --import tsx src/lib/abr_data/duckdb_smoke.test.ts
```

Expected: **3つすべて pass**。もし fail した場合は、メソッド名 (`runAndReadAll` vs `run`、`createAppender(table)` vs `createAppender(schema, table)`、`closeSync` vs `close` など) を `node_modules/@duckdb/node-api/dist/*.d.ts` を読んで実 API に合わせて修正する。

**重要**: ここで API シグネチャが確定するので、後続タスクで使う API パターンはここで通ったものを正解とする。

- [ ] **Step 4: コミット**

```bash
git add package.json package-lock.json src/lib/abr_data/duckdb_smoke.test.ts
git commit -m "Add @duckdb/node-api dependency with API smoke test"
```

---

## Task 2: SQLite 実装を `merge_sqlite.ts` に抽出 (try/finally 化を含む)

既存実装をファイル分割するだけのリファクタ。挙動は変えない。ただし throw 時の `db.close()` リーク修正は同時に入れる (設計書 5章)。

**Files:**
- Create: `src/lib/abr_data/merge_sqlite.ts`
- Modify: `src/lib/abr_data/index.ts` (中身を merge_sqlite から re-export に置き換え)

- [ ] **Step 1: 既存テストが green であることを確認 (ベースライン)**

```bash
npm test
```

Expected: 全テスト pass。ここで fail があれば先にユーザーに報告。

- [ ] **Step 2: `merge_sqlite.ts` を新規作成**

```ts
// src/lib/abr_data/merge_sqlite.ts
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _createKey(data: any, keys: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return keys.map((key) => `${data[key]}`).join("|");
}

export async function *mergeDataLeftJoinSqlite<T, U>(
  left: AsyncIterableIterator<T>,
  right: AsyncIterableIterator<U>,
  keys: string[],
  memory: boolean = false,
): AsyncIterableIterator<T | (T & U)> {
  let tmpDbPath = ":memory:";
  let tmpDir: string | undefined;

  if (!memory) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "merge-data-left-join-"));
    tmpDbPath = path.join(tmpDir, "db.sqlite3");
    console.log(`Creating temporary database: ${tmpDbPath}`);
  }

  const db = new Database(tmpDbPath);
  try {
    db.pragma("synchronous = OFF");
    db.pragma("journal_mode = MEMORY");
    db.exec(`
      CREATE TABLE l (
        key TEXT,
        data JSONB
      );
      CREATE TABLE r (
        key TEXT,
        data JSONB
      );
    `);
    const stmt1 = db.prepare("INSERT INTO l VALUES (?, ?)");
    const stmt2 = db.prepare("INSERT INTO r VALUES (?, ?)");

    await Promise.all([
      pipeline(left, async function (source) {
        for await (const data of source) {
          stmt1.run(_createKey(data, keys), JSON.stringify(data));
        }
      }),
      pipeline(right, async function (source) {
        for await (const data of source) {
          stmt2.run(_createKey(data, keys), JSON.stringify(data));
        }
      }),
    ]);
    db.exec(`
      CREATE INDEX l_key ON l(key);
      CREATE INDEX r_key ON r(key);
    `);

    const select = db.prepare<void[], { d01: string }>(`
      SELECT
        json_patch(l.data, coalesce(r.data, '{}')) AS d01
      FROM
        l
        LEFT JOIN r ON l.key = r.key
    `);
    for (const data of select.iterate()) {
      yield JSON.parse(data.d01);
    }
  } finally {
    db.close();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true });
    }
  }
}
```

- [ ] **Step 3: `index.ts` を re-export 形式に書き換え**

```ts
// src/lib/abr_data/index.ts
export { mergeDataLeftJoinSqlite as mergeDataLeftJoin } from "./merge_sqlite.js";
```

- [ ] **Step 4: 既存テストが依然 green であることを確認**

```bash
node --test --import tsx src/lib/abr_data/index.test.ts
```

Expected: 既存 2 ケースが pass。

- [ ] **Step 5: 全テスト走らせて回帰が無いことを確認**

```bash
npm test
```

Expected: 全 pass。

- [ ] **Step 6: コミット**

```bash
git add src/lib/abr_data/merge_sqlite.ts src/lib/abr_data/index.ts
git commit -m "Extract SQLite merge implementation with resource cleanup"
```

---

## Task 3: 両バックエンド対応テスト matrix の骨組みを作る (DuckDB 側は失敗する)

ここで DuckDB 側のテスト記述を先に書き、まだ実装がないので fail する状態を作る。次のタスクで実装して green にする。

**Files:**
- Modify: `src/lib/abr_data/index.test.ts` (matrix 化)

- [ ] **Step 1: 内部実装を直接 import する matrix テストに書き換え**

```ts
// src/lib/abr_data/index.test.ts
import assert from 'node:assert';
import test, { describe } from 'node:test';

import { mergeDataLeftJoinSqlite } from './merge_sqlite.js';
import { mergeDataLeftJoinDuckdb } from './merge_duckdb.js';

const backends = {
  sqlite: mergeDataLeftJoinSqlite,
  duckdb: mergeDataLeftJoinDuckdb,
} as const;

for (const [name, mergeDataLeftJoin] of Object.entries(backends)) {
  await describe(`mergeDataLeftJoin [${name}]`, async () => {
    await test('it correctly joins two async iterators when they are ordered', async () => {
      const one = async function*(){
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield *[
          { id: 100, name: 'Alice' },
          { id: 101, name: 'Bob' }
        ];
      };
      const two = async function*(){
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield *[
          { id: 100, age: 500 },
          { id: 101, age: 501 }
        ];
      };

      const res = await Array.fromAsync(
        mergeDataLeftJoin(one(), two(), ['id'])
      );

      assert.deepStrictEqual(res, [
        { id: 100, name: 'Alice', age: 500 },
        { id: 101, name: 'Bob', age: 501 },
      ]);
    });

    await test('it correctly joins two async iterators when they are out of order', async () => {
      const one = async function *() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield *[{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Charlie' }];
      };
      const two = async function *() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield *[{ id: 2, age: 30 }, { id: 1, age: 25 }, { id: 4, age: 35 }];
      };

      const res = await Array.fromAsync(
        mergeDataLeftJoin(one(), two(), ['id'])
      );

      assert.deepStrictEqual(res, [
        { id: 1, name: 'Alice', age: 25 },
        { id: 2, name: 'Bob', age: 30 },
        { id: 3, name: 'Charlie' },
      ]);
    });
  });
}
```

- [ ] **Step 2: テストを走らせて DuckDB 側が失敗することを確認**

```bash
node --test --import tsx src/lib/abr_data/index.test.ts
```

Expected: `mergeDataLeftJoin [sqlite]` の 2 ケースは pass。`mergeDataLeftJoin [duckdb]` は **import エラーで全件 fail** ( `merge_duckdb.js` がまだ無いため)。これが正しい "red" 状態。

- [ ] **Step 3: コミットせずに次のタスクへ**

このタスクは Task 4 と1コミットにまとめる (red のままコミットしない)。

---

## Task 4: `merge_duckdb.ts` の最小実装で matrix テストを green にする

Task 3 の red を消す最小実装。Appender と stream を使ったストリーミング実装。

**Files:**
- Create: `src/lib/abr_data/merge_duckdb.ts`

- [ ] **Step 1: `merge_duckdb.ts` を新規作成**

```ts
// src/lib/abr_data/merge_duckdb.ts
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
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
    await connection.run(`
      CREATE TABLE l (key VARCHAR, data JSON);
      CREATE TABLE r (key VARCHAR, data JSON);
    `);

    await Promise.all([
      _appendStream(connection, "l", left, keys),
      _appendStream(connection, "r", right, keys),
    ]);

    const reader = await connection.stream(`
      SELECT json_merge_patch(l.data, COALESCE(r.data, '{}'::JSON)) AS d01
      FROM l LEFT JOIN r ON l.key = r.key
    `);
    while (true) {
      const chunk = await reader.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      const rows = chunk.getRowObjects();
      for (const row of rows) {
        yield JSON.parse(row.d01 as string);
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
```

- [ ] **Step 2: matrix テストを実行して green を確認**

```bash
node --test --import tsx src/lib/abr_data/index.test.ts
```

Expected: `[sqlite]` 2件 + `[duckdb]` 2件 = **計 4 件 pass**。

もし fail する場合の調査ポイント:
- `connection.stream()` の戻り値の reader interface が異なる → Task 1 smoke で確認した API を流用
- `appender.appendVarchar` で JSON 文字列がエラー → `appendValue(value)` や `appendVarchar` の型キャスト挙動を確認
- `chunk.getRowObjects()` のカラム名キーが lowercase / uppercase 違い → SQL を `AS d01` で明示

- [ ] **Step 3: 全テスト走らせて回帰なしを確認**

```bash
npm test
```

Expected: 全 pass。

- [ ] **Step 4: コミット (Task 3 と Task 4 を 1 コミットに)**

```bash
git add src/lib/abr_data/index.test.ts src/lib/abr_data/merge_duckdb.ts
git commit -m "Add DuckDB merge implementation with backend matrix tests"
```

---

## Task 5: `index.ts` の dispatcher 化 (env `MERGE_BACKEND` 切替)

ここまでで両実装が直接 import で動く。次に呼び出し元 (02/03/04) から見える `mergeDataLeftJoin` を env 切替できる dispatcher にする。

**Files:**
- Modify: `src/lib/abr_data/index.ts`
- Create: `src/lib/abr_data/index_dispatch.test.ts` (dispatcher 単体テスト)

- [ ] **Step 1: dispatcher を実装**

```ts
// src/lib/abr_data/index.ts
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
```

- [ ] **Step 2: dispatcher のテストを書く**

```ts
// src/lib/abr_data/index_dispatch.test.ts
import assert from 'node:assert';
import test, { describe } from 'node:test';

import { mergeDataLeftJoin } from './index.js';

async function* gen<T>(items: T[]): AsyncIterableIterator<T> {
  for (const it of items) yield it;
}

await describe('mergeDataLeftJoin dispatcher', async () => {
  await test('defaults to sqlite when MERGE_BACKEND is unset', async () => {
    delete process.env.MERGE_BACKEND;
    const res = await Array.fromAsync(mergeDataLeftJoin(
      gen([{ id: 1, a: 'x' }]),
      gen([{ id: 1, b: 'y' }]),
      ['id'],
    ));
    assert.deepStrictEqual(res, [{ id: 1, a: 'x', b: 'y' }]);
  });

  await test('uses duckdb when MERGE_BACKEND=duckdb', async () => {
    process.env.MERGE_BACKEND = 'duckdb';
    try {
      const res = await Array.fromAsync(mergeDataLeftJoin(
        gen([{ id: 1, a: 'x' }]),
        gen([{ id: 1, b: 'y' }]),
        ['id'],
      ));
      assert.deepStrictEqual(res, [{ id: 1, a: 'x', b: 'y' }]);
    } finally {
      delete process.env.MERGE_BACKEND;
    }
  });

  await test('falls back to sqlite for unknown MERGE_BACKEND', async () => {
    process.env.MERGE_BACKEND = 'unknown';
    try {
      const res = await Array.fromAsync(mergeDataLeftJoin(
        gen([{ id: 1, a: 'x' }]),
        gen([{ id: 1, b: 'y' }]),
        ['id'],
      ));
      assert.deepStrictEqual(res, [{ id: 1, a: 'x', b: 'y' }]);
    } finally {
      delete process.env.MERGE_BACKEND;
    }
  });
});
```

- [ ] **Step 3: dispatcher テストを実行して全 pass を確認**

```bash
node --test --import tsx src/lib/abr_data/index_dispatch.test.ts
```

Expected: 3 件 pass。

- [ ] **Step 4: 全テスト走らせて回帰なしを確認**

```bash
npm test
```

Expected: 全 pass。02/03/04 を実際に走らせる End-to-end は Task 9 で実施する。

- [ ] **Step 5: コミット**

```bash
git add src/lib/abr_data/index.ts src/lib/abr_data/index_dispatch.test.ts
git commit -m "Add MERGE_BACKEND env dispatcher for SQLite/DuckDB selection"
```

---

## Task 6: クロスバックエンド等価性テストを追加

「両バックエンドが同じ入力に対して同じ出力を返す」ことを明示的に保証するテスト。実データ移行前の安全網。

**Files:**
- Modify: `src/lib/abr_data/index.test.ts` (末尾に describe 追加)

- [ ] **Step 1: クロスバックエンド等価性テストを書く**

`index.test.ts` の `}` (最後の閉じ) の直前に以下を追加:

```ts
await describe('cross-backend equivalence', async () => {
  await test('sqlite and duckdb produce same output for ordered input', async () => {
    const makeOne = () => (async function*(){
      yield *[
        { id: 100, name: 'Alice' },
        { id: 101, name: 'Bob' }
      ];
    })();
    const makeTwo = () => (async function*(){
      yield *[
        { id: 100, age: 500 },
        { id: 101, age: 501 }
      ];
    })();

    const sqliteRes = await Array.fromAsync(
      mergeDataLeftJoinSqlite(makeOne(), makeTwo(), ['id'])
    );
    const duckdbRes = await Array.fromAsync(
      mergeDataLeftJoinDuckdb(makeOne(), makeTwo(), ['id'])
    );

    assert.deepStrictEqual(sqliteRes, duckdbRes);
  });

  await test('sqlite and duckdb produce same output (sorted) for out-of-order input', async () => {
    const makeOne = () => (async function*(){
      yield *[{ id: 3, name: 'Charlie' }, { id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
    })();
    const makeTwo = () => (async function*(){
      yield *[{ id: 2, age: 30 }, { id: 1, age: 25 }, { id: 4, age: 35 }];
    })();

    const sqliteRes = await Array.fromAsync(
      mergeDataLeftJoinSqlite(makeOne(), makeTwo(), ['id'])
    );
    const duckdbRes = await Array.fromAsync(
      mergeDataLeftJoinDuckdb(makeOne(), makeTwo(), ['id'])
    );

    // 順序差異は許容、内容のみ比較
    const sortById = (a: { id: number }, b: { id: number }) => a.id - b.id;
    assert.deepStrictEqual(
      [...sqliteRes].sort(sortById),
      [...duckdbRes].sort(sortById),
    );
  });
});
```

- [ ] **Step 2: テスト実行**

```bash
node --test --import tsx src/lib/abr_data/index.test.ts
```

Expected: 計 6 件 pass (`[sqlite]` 2 + `[duckdb]` 2 + `cross-backend equivalence` 2)。

もし `out-of-order` のクロスバックエンドが fail する場合は、両実装の LEFT JOIN がそれぞれ異なる順序で結果を返している可能性が高い。これは設計上許容で、sort して比較するロジックが入っているため通るはず。

- [ ] **Step 3: コミット**

```bash
git add src/lib/abr_data/index.test.ts
git commit -m "Add cross-backend equivalence tests for merge join"
```

---

## Task 7: エッジケーステスト追加 (空入力 / RFC 7396 null 削除)

設計書 6章で挙げた追加テスト。matrix の中で各バックエンドが同じ挙動を示すことを確認。

**Files:**
- Modify: `src/lib/abr_data/index.test.ts`

- [ ] **Step 1: 空入力テストを matrix 内の describe に追加**

`for (const [name, mergeDataLeftJoin] of Object.entries(backends))` ブロックの中の describe 内、既存テストの後ろに追加:

```ts
    await test('empty left returns nothing', async () => {
      const empty = async function*(){}();
      const right = async function*(){ yield { id: 1, age: 25 }; }();
      const res = await Array.fromAsync(
        mergeDataLeftJoin(empty as AsyncIterableIterator<{id: number}>, right, ['id'])
      );
      assert.deepStrictEqual(res, []);
    });

    await test('empty right yields left items unchanged', async () => {
      const left = async function*(){ yield { id: 1, name: 'Alice' }; }();
      const empty = async function*(){}();
      const res = await Array.fromAsync(
        mergeDataLeftJoin(left, empty as AsyncIterableIterator<{id: number}>, ['id'])
      );
      assert.deepStrictEqual(res, [{ id: 1, name: 'Alice' }]);
    });

    await test('both empty returns nothing', async () => {
      const e1 = async function*(){}() as AsyncIterableIterator<{id: number}>;
      const e2 = async function*(){}() as AsyncIterableIterator<{id: number}>;
      const res = await Array.fromAsync(
        mergeDataLeftJoin(e1, e2, ['id'])
      );
      assert.deepStrictEqual(res, []);
    });

    await test('right key value overrides left key value', async () => {
      const left = async function*(){ yield { id: 1, status: 'pending' }; }();
      const right = async function*(){ yield { id: 1, status: 'active', age: 25 }; }();
      const res = await Array.fromAsync(
        mergeDataLeftJoin(left, right, ['id'])
      );
      assert.deepStrictEqual(res, [{ id: 1, status: 'active', age: 25 }]);
    });
```

注意: RFC 7396 の null 削除セマンティクスについては、SQLite `json_patch` と DuckDB `json_merge_patch` で挙動差がある可能性がある。クロスバックエンド等価性テスト (Task 6) で検出されるので、ここでは個別の null 削除テストは追加しない (検出されたらその時点で対処)。

- [ ] **Step 2: テスト実行**

```bash
node --test --import tsx src/lib/abr_data/index.test.ts
```

Expected: 計 14 件 pass (`[sqlite]` 6 + `[duckdb]` 6 + cross-backend 2)。

- [ ] **Step 3: コミット**

```bash
git add src/lib/abr_data/index.test.ts
git commit -m "Add empty-input and right-override tests for merge join"
```

---

## Task 8: ベンチマークスクリプトの作成

設計書 7 章のベンチスクリプト。`scripts/bench/` 配下に置く。

**Files:**
- Create: `scripts/bench/run_bench.sh`
- Create: `scripts/bench/.gitignore` (bench-results を除外)
- Create: `scripts/bench/README.md`

- [ ] **Step 1: ベンチスクリプト本体**

```bash
# scripts/bench/run_bench.sh
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <京都府|北海道> <sqlite|duckdb>" >&2
  exit 1
fi

PREF="$1"
BACKEND="$2"

if [[ "$BACKEND" != "sqlite" && "$BACKEND" != "duckdb" ]]; then
  echo "BACKEND must be 'sqlite' or 'duckdb'" >&2
  exit 1
fi

SETTINGS_FILE="settings-${PREF}.json"
if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "settings file not found: $SETTINGS_FILE" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
OUTDIR="bench-results/${PREF}-${BACKEND}-${STAMP}"
mkdir -p "$OUTDIR"

export SETTINGS_JSON="$(cat "$SETTINGS_FILE")"
export MERGE_BACKEND="$BACKEND"

# クリーンスタート: 既存 out を退避
if [[ -d out ]]; then
  mv out "out.bak-${STAMP}"
fi

for step in 02_make_machi_aza 03_make_rsdt 04_make_chiban; do
  echo "=== Running $step (backend=$BACKEND, pref=$PREF) ==="
  /usr/bin/time -l -o "$OUTDIR/${step}.time" \
    npm run "run:${step}" 2>&1 | tee "$OUTDIR/${step}.log"
done

echo "=== Snapshotting output ==="
tar -cf "$OUTDIR/out-snapshot.tar" out/api
find out/api -type f | sort | xargs shasum -a 256 > "$OUTDIR/checksums.sha256"

echo "=== Done. Results: $OUTDIR ==="
```

- [ ] **Step 2: 実行可能化**

```bash
chmod +x scripts/bench/run_bench.sh
```

- [ ] **Step 3: bench-results 用 .gitignore**

```
# scripts/bench/.gitignore
bench-results/
```

- [ ] **Step 4: README**

````markdown
<!-- scripts/bench/README.md -->
# Bench: SQLite vs DuckDB

`mergeDataLeftJoin` の SQLite / DuckDB 実装を 02/03/04 パイプラインで比較する。

## 前提

- `settings-京都府.json` または `settings-北海道.json` をプロジェクトルートに配置
- `npm ci` 済み
- 01_make_prefecture_city は別途実行済み (本ベンチは 02/03/04 のみ計測)

## 使い方

```bash
./scripts/bench/run_bench.sh 京都府 sqlite
./scripts/bench/run_bench.sh 京都府 duckdb
./scripts/bench/run_bench.sh 北海道 sqlite
./scripts/bench/run_bench.sh 北海道 duckdb
```

各 3 反復走らせて中央値を `2026-05-23-sqlite-to-duckdb-bench-results.md` に記録する。

## 出力

- `bench-results/<pref>-<backend>-<stamp>/`
  - `*.time`: `/usr/bin/time -l` の rusage 出力 (wall time, peak RSS 等)
  - `*.log`: 各ステップの stdout/stderr
  - `out-snapshot.tar`: `out/api/` のスナップショット
  - `checksums.sha256`: byte 一致比較用ハッシュ
````

- [ ] **Step 5: スクリプトが syntax error 無く読めることを確認**

```bash
bash -n scripts/bench/run_bench.sh
```

Expected: 何も出力されない (exit 0)。

- [ ] **Step 6: コミット**

```bash
git add scripts/bench/
git commit -m "Add benchmark script for SQLite vs DuckDB merge comparison"
```

---

## Task 9: 京都府ベンチマークの実行と結果記録

実データで `MERGE_BACKEND=duckdb` が動くことの End-to-End 検証も兼ねる。京都府で 2 backend × 3 反復 = 6 ラン。

**Files:**
- Create: `docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md`

- [ ] **Step 1: 京都府ベンチを sqlite で 3 反復**

```bash
./scripts/bench/run_bench.sh 京都府 sqlite
./scripts/bench/run_bench.sh 京都府 sqlite
./scripts/bench/run_bench.sh 京都府 sqlite
```

Expected: それぞれ完走、`bench-results/京都府-sqlite-*/` が 3 ディレクトリ生成される。

- [ ] **Step 2: 京都府ベンチを duckdb で 3 反復**

```bash
./scripts/bench/run_bench.sh 京都府 duckdb
./scripts/bench/run_bench.sh 京都府 duckdb
./scripts/bench/run_bench.sh 京都府 duckdb
```

Expected: 完走。途中で API エラー等が出る場合は Task 4 の DuckDB 実装に戻って修正。

- [ ] **Step 3: 出力の byte 一致を検証**

最新の sqlite ラン (例: `京都府-sqlite-X`) と duckdb ラン (例: `京都府-duckdb-Y`) の checksums を比較:

```bash
diff <(awk '{print $1, $2}' bench-results/京都府-sqlite-*/checksums.sha256 | sort -k2) \
     <(awk '{print $1, $2}' bench-results/京都府-duckdb-*/checksums.sha256 | sort -k2)
```

Expected: **差分なし** (byte-exact 一致)。差分があれば、原因 (JSON キー順、null 削除セマンティクス、空白等) を調査し、必要なら設計書 9 章のリスクとして文書化。

- [ ] **Step 4: メトリクス抽出 (中央値)**

各 `*.time` ファイルから wall time (real) と maximum resident set size を抜き出す:

```bash
for f in bench-results/京都府-sqlite-*/02_make_machi_aza.time; do
  awk '/real/{wall=$1} /maximum resident set size/{rss=$1} END{print FILENAME, wall, rss}' "$f"
done
```

3 反復のうち中央値を採用。03/04 についても同様。

- [ ] **Step 5: 結果ドキュメントを作成**

```markdown
<!-- docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md -->
# SQLite vs DuckDB ベンチマーク結果

- 計測日: 2026-05-XX
- ブランチ: `sqlite-to-duckdb-benchmark`
- 環境: macOS Darwin 25.5.0 / Node.js 22.9.0 / <CPU info: e.g. Apple M3 Pro>
- 設定: settings-京都府.json (lgCodes: ^26 等)
- 反復: 3 回、中央値を採用

## 京都府

### wall time (秒)

| ステップ            | SQLite | DuckDB | 比率 (DuckDB/SQLite) |
|--------------------|--------|--------|---------------------|
| 02_make_machi_aza  | ?      | ?      | ?                   |
| 03_make_rsdt       | ?      | ?      | ?                   |
| 04_make_chiban     | ?      | ?      | ?                   |
| 合計                | ?      | ?      | ?                   |

### peak RSS (MB)

| ステップ            | SQLite | DuckDB |
|--------------------|--------|--------|
| 02_make_machi_aza  | ?      | ?      |
| 03_make_rsdt       | ?      | ?      |
| 04_make_chiban     | ?      | ?      |

### 出力 byte 一致

- sqlite vs duckdb の `out/api/` 全ファイル SHA-256 比較: **<一致 / 不一致>**
- 不一致があった場合の差分内容: <ファイル名と差分の要約>

### 依存サイズ・install 時間

| 項目                       | SQLite (better-sqlite3) | DuckDB (@duckdb/node-api) |
|---------------------------|-------------------------|---------------------------|
| `du -sh node_modules/...` | ?                       | ?                         |

`npm ci` 全体時間: ? 秒 (DuckDB 追加前) → ? 秒 (追加後)

## 北海道

(同じテンプレートで Task 10 で記入)

## 所感と推奨

- (DuckDB が wall time で勝つ/負ける、メモリで勝つ/負ける、出力一致、その他)
- 採用推奨可否: ?
```

実測値を埋める。

- [ ] **Step 6: コミット**

```bash
git add docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md
git commit -m "Record Kyoto benchmark results for SQLite vs DuckDB merge"
```

---

## Task 10: 北海道ベンチマークの実行と結果反映

北海道でも 2 backend × 3 反復。京都府と同じ手順、結果ドキュメントに追記。

**Files:**
- Modify: `docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md`

- [ ] **Step 1: 北海道ベンチを sqlite で 3 反復**

```bash
./scripts/bench/run_bench.sh 北海道 sqlite
./scripts/bench/run_bench.sh 北海道 sqlite
./scripts/bench/run_bench.sh 北海道 sqlite
```

- [ ] **Step 2: 北海道ベンチを duckdb で 3 反復**

```bash
./scripts/bench/run_bench.sh 北海道 duckdb
./scripts/bench/run_bench.sh 北海道 duckdb
./scripts/bench/run_bench.sh 北海道 duckdb
```

- [ ] **Step 3: byte 一致検証 (北海道)**

```bash
diff <(awk '{print $1, $2}' bench-results/北海道-sqlite-*/checksums.sha256 | sort -k2) \
     <(awk '{print $1, $2}' bench-results/北海道-duckdb-*/checksums.sha256 | sort -k2)
```

Expected: 差分なし。

- [ ] **Step 4: 結果ドキュメントの「北海道」セクションを実測値で埋める**

Task 9 step 5 で作った markdown の「北海道」セクションを、京都府と同じテーブル形式で埋める。

- [ ] **Step 5: 「所感と推奨」セクションを書く**

実測値をもとに、以下を 200 字程度で結論:
- どのステップで DuckDB が勝つ/負ける
- メモリ削減効果はあるか
- 採用推奨か (両指標で同等以上 + byte 一致が前提)

- [ ] **Step 6: コミット**

```bash
git add docs/superpowers/specs/2026-05-23-sqlite-to-duckdb-bench-results.md
git commit -m "Record Hokkaido benchmark results and final recommendation"
```

---

## 完了後の状態 (Done 定義)

- ブランチ `sqlite-to-duckdb-benchmark` 上で:
  - 全テスト (sqlite/duckdb 両方の matrix + dispatcher + cross-backend) green
  - 京都府・北海道で `MERGE_BACKEND=duckdb` 含めて 02/03/04 が完走
  - 両 backend の `out/api/` が byte-exact 一致 (差分があれば仕様書 9 章のリスクに追記)
  - ベンチ結果が markdown 表として 2026-05-23-sqlite-to-duckdb-bench-results.md に記録済み
- main へのマージ判断は実測結果を見てユーザーが行う (本計画には含めない)

---

## Self-Review

### Spec coverage

- [x] 設計書 1章 (背景): Task 概要で参照
- [x] 設計書 2章 (設計判断): Task 1 (@duckdb/node-api), Task 4 (Appender, HASH JOIN), Task 5 (env dispatcher)
- [x] 設計書 3章 (アーキテクチャ): Task 2 (sqlite 抽出), Task 4 (duckdb 作成), Task 5 (dispatcher)
- [x] 設計書 4章 (データフロー): Task 4 の merge_duckdb.ts に対応
- [x] 設計書 5章 (try/finally): Task 2 の SQLite 抽出時、Task 4 の DuckDB 実装で実施
- [x] 設計書 6章 (テスト): Task 3, 6, 7 で matrix / cross-backend / 追加ケース
- [x] 設計書 7章 (ベンチ): Task 8 (スクリプト), Task 9-10 (実行)
- [x] 設計書 8章 (Done): 計画末尾の「完了後の状態」
- [x] 設計書 9章 (リスク): JSON merge null セマンティクス → cross-backend 等価性テストで検出 (Task 6) / API 不確実性 → Task 1 smoke で確定

### Placeholder scan

- 唯一の placeholder は Task 9 step 5 / Task 10 step 4 の **実測値の `?` プレース**。これは実行後でないと埋められないので、Task 9-10 のステップ自体に「実測値を埋める」と明示してある。

### Type consistency

- `mergeDataLeftJoinSqlite` / `mergeDataLeftJoinDuckdb` の named export は Task 2, 4, 5 で一貫
- dispatcher の `mergeDataLeftJoin` シグネチャは全タスクで同一: `(left, right, keys, memory)`
- env 変数名 `MERGE_BACKEND` は Task 5, 8 で一貫
