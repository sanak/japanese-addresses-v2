import assert from 'node:assert';
import test, { describe } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';

await describe('@duckdb/node-api smoke', async () => {
  await test('SELECT works', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const reader = await connection.runAndReadAll('SELECT 42 AS x');
    await reader.readAll();
    const rows = reader.getRowObjects();
    assert.deepStrictEqual(rows, [{ x: 42 }]); // getRowObjects() converts to JS number
    connection.closeSync();
    instance.closeSync();
  });

  await test('json_merge_patch works', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const reader = await connection.runAndReadAll(
      `SELECT json_merge_patch('{"a":1,"b":2}'::JSON, '{"b":3,"c":4}'::JSON) AS merged`
    );
    await reader.readAll();
    const rows = reader.getRowObjects();
    const merged = JSON.parse(rows[0].merged as string);
    assert.strictEqual(merged.a, 1);
    assert.strictEqual(merged.b, 3);
    assert.strictEqual(merged.c, 4);
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
    await reader.readAll();
    const rows = reader.getRowObjects();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].key, 'k1');
    connection.closeSync();
    instance.closeSync();
  });
});
