import assert from 'node:assert';
import test from 'node:test';

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import * as zip_tools from './zip_tools.js';

const fixtureDir = path.join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'lib', 'zip_tools');

await test.describe('unzipAndExtractZipFile', async () => {
  await test('it works for a single layer of zip', async () => {
    const filePath = path.join(fixtureDir, 'single_level.csv.zip');
    const stream = fs.createReadStream(filePath);
    const files = await Array.fromAsync(zip_tools.unzipAndExtractZipFile(stream));
    assert.strictEqual(files.length, 1);
    const file0 = Buffer.concat(await Array.fromAsync(files[0])).toString('utf-8');
    assert.strictEqual(file0, `It,works!\n\n`);
  });

  await test('it works for a double layer of zip', async () => {
    const filePath = path.join(fixtureDir, 'double_level.csv.zip');
    const stream = fs.createReadStream(filePath);
    const files = await Array.fromAsync(zip_tools.unzipAndExtractZipFile(stream));
    assert.strictEqual(files.length, 2);

    const file0 = Buffer.concat(await Array.fromAsync(files[0])).toString('utf-8');
    assert.strictEqual(file0, `It,works!\nDouble,1\n`);

    const file1 = Buffer.concat(await Array.fromAsync(files[1])).toString('utf-8');
    assert.strictEqual(file1, `It,works!\nDouble,2\n`);
  });
});

await test.describe('unzipAndExtractZipBuffer', async () => {
  await test('it works for a single layer of zip', async () => {
    const filePath = path.join(fixtureDir, 'single_level.csv.zip');
    const buffer = await fs.promises.readFile(filePath);
    const files = await Array.fromAsync(zip_tools.unzipAndExtractZipBuffer(buffer));
    assert.strictEqual(files.length, 1);
    const file0 = files[0].toString('utf-8');
    assert.strictEqual(file0, `It,works!\n\n`);
  });

  await test('it works for a double layer of zip', async () => {
    const filePath = path.join(fixtureDir, 'double_level.csv.zip');
    const buffer = await fs.promises.readFile(filePath);
    const files = await Array.fromAsync(zip_tools.unzipAndExtractZipBuffer(buffer));
    assert.strictEqual(files.length, 2);

    const file0 = files[0].toString('utf-8');
    assert.strictEqual(file0, `It,works!\nDouble,1\n`);

    const file1 = files[1].toString('utf-8');
    assert.strictEqual(file1, `It,works!\nDouble,2\n`);
  });
});

await test.describe('unzipToFiles', async () => {
  await test('writes single-layer csv to outDir and returns paths', async () => {
    const filePath = path.join(fixtureDir, 'single_level.csv.zip');
    const buffer = await fs.promises.readFile(filePath);
    const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unzipToFiles-'));
    try {
      const paths = await zip_tools.unzipToFiles(buffer, outDir);
      assert.strictEqual(paths.length, 1);
      assert.ok(paths[0].startsWith(outDir));
      assert.ok(paths[0].endsWith('.csv'));
      const content = await fs.promises.readFile(paths[0], 'utf-8');
      assert.strictEqual(content, 'It,works!\n\n');
    } finally {
      await fs.promises.rm(outDir, { recursive: true, force: true });
    }
  });

  await test('writes double-layer csvs and de-collides identical inner names', async () => {
    const filePath = path.join(fixtureDir, 'double_level.csv.zip');
    const buffer = await fs.promises.readFile(filePath);
    const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unzipToFiles-'));
    try {
      const paths = await zip_tools.unzipToFiles(buffer, outDir);
      assert.strictEqual(paths.length, 2);
      const names = paths.map((p) => path.basename(p)).sort();
      assert.notStrictEqual(names[0], names[1]);
      const contents = await Promise.all(paths.map((p) => fs.promises.readFile(p, 'utf-8')));
      assert.ok(contents.includes('It,works!\nDouble,1\n'));
      assert.ok(contents.includes('It,works!\nDouble,2\n'));
    } finally {
      await fs.promises.rm(outDir, { recursive: true, force: true });
    }
  });
});
