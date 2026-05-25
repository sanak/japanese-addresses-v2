/* eslint-disable @typescript-eslint/require-await */
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

    await test('empty left returns nothing', async () => {
      const empty = (async function*(){})() as AsyncIterableIterator<{id: number}>;
      const right = (async function*(){ yield { id: 1, age: 25 }; })();
      const res = await Array.fromAsync(
        mergeDataLeftJoin(empty, right, ['id'])
      );
      assert.deepStrictEqual(res, []);
    });

    await test('empty right yields left items unchanged', async () => {
      const left = (async function*(){ yield { id: 1, name: 'Alice' }; })();
      const empty = (async function*(){})() as AsyncIterableIterator<{id: number}>;
      const res = await Array.fromAsync(
        mergeDataLeftJoin(left, empty, ['id'])
      );
      assert.deepStrictEqual(res, [{ id: 1, name: 'Alice' }]);
    });

    await test('both empty returns nothing', async () => {
      const e1 = (async function*(){})() as AsyncIterableIterator<{id: number}>;
      const e2 = (async function*(){})() as AsyncIterableIterator<{id: number}>;
      const res = await Array.fromAsync(
        mergeDataLeftJoin(e1, e2, ['id'])
      );
      assert.deepStrictEqual(res, []);
    });

    await test('right key value overrides left key value', async () => {
      const left = (async function*(){ yield { id: 1, status: 'pending' }; })();
      const right = (async function*(){ yield { id: 1, status: 'active', age: 25 }; })();
      const res = await Array.fromAsync(
        mergeDataLeftJoin(left, right, ['id'])
      );
      assert.deepStrictEqual(res, [{ id: 1, status: 'active', age: 25 }]);
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
