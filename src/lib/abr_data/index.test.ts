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

    const sortById = (a: { id: number }, b: { id: number }) => a.id - b.id;
    assert.deepStrictEqual(
      [...sqliteRes].sort(sortById),
      [...duckdbRes].sort(sortById),
    );
  });
});
