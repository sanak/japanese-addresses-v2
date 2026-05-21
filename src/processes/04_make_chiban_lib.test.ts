import assert from 'node:assert';
import test, { describe } from 'node:test';

import { serializeApiDataTxt, HEADER_CHUNK_SIZE, type ChibanApi } from './04_make_chiban_lib.js';
import { SingleMachiAza } from '../data.js';

function ma(overrides: Partial<SingleMachiAza> = {}): SingleMachiAza {
  return {
    machiaza_id: '0001000',
    oaza_cho: '本町',
    chome: '',
    koaza: '',
    ...overrides,
  };
}

await describe('serializeApiDataTxt', async () => {
  await test('returns empty-section header padded to HEADER_CHUNK_SIZE for empty input', () => {
    const result = serializeApiDataTxt([]);
    assert.equal(result.headerIterations, 1);
    assert.deepEqual(result.headerData, []);
    assert.equal(result.data.length, HEADER_CHUNK_SIZE);
    // ヘッダ末尾は =END=\n のみ
    assert.ok(result.data.toString('utf8', 0, 6).startsWith('=END=\n'));
  });

  await test('serializes a single machi-aza with one chiban', () => {
    const apiData: ChibanApi = [{
      machiAza: ma({ oaza_cho: '本町', chome: '1丁目' }),
      chibans: [{ prc_num1: '12', prc_num2: undefined, prc_num3: undefined, point: undefined }],
    }];
    const result = serializeApiDataTxt(apiData);
    assert.equal(result.headerIterations, 1);
    assert.equal(result.headerData.length, 1);
    assert.equal(result.headerData[0].name, '本町1丁目');
    // セクション本体は header の後ろに置かれる
    const sectionStart = result.headerData[0].offset;
    const sectionLen = result.headerData[0].length;
    const sectionText = result.data.toString('utf8', sectionStart, sectionStart + sectionLen);
    assert.ok(sectionText.includes('地番,本町1丁目\n'));
    assert.ok(sectionText.includes('prc_num1,prc_num2,prc_num3,lng,lat\n'));
    assert.ok(sectionText.includes('12,,,,\n'));
  });

  await test('serializes multiple machi-aza with sequential offsets', () => {
    const apiData: ChibanApi = [
      { machiAza: ma({ oaza_cho: '一丁目' }), chibans: [{ prc_num1: '1', prc_num2: undefined, prc_num3: undefined, point: undefined }] },
      { machiAza: ma({ oaza_cho: '二丁目' }), chibans: [{ prc_num1: '2', prc_num2: undefined, prc_num3: undefined, point: undefined }] },
    ];
    const result = serializeApiDataTxt(apiData);
    assert.equal(result.headerData.length, 2);
    // 2 つ目のオフセットは 1 つ目のオフセット + 1 つ目の長さ
    assert.equal(
      result.headerData[1].offset,
      result.headerData[0].offset + result.headerData[0].length,
    );
  });

  await test('expands header to multiple chunks when needed', () => {
    // HEADER_CHUNK_SIZE = 50000 byte を超えるには合計バイト数を確実に超過させる必要がある。
    // name を長めの日本語 (約 30 byte) にして 4000 entry 投入する
    const apiData: ChibanApi = [];
    for (let i = 0; i < 4000; i++) {
      apiData.push({
        machiAza: ma({ oaza_cho: `町字名長めの名前テスト${i}` }),
        chibans: [{ prc_num1: '1', prc_num2: undefined, prc_num3: undefined, point: undefined }],
      });
    }
    const result = serializeApiDataTxt(apiData);
    assert.ok(result.headerIterations >= 2, `expected >= 2 iterations, got ${result.headerIterations}`);
    // 全 entry のオフセットがヘッダ領域の外を指している
    const headerMaxSize = HEADER_CHUNK_SIZE * result.headerIterations;
    for (const row of result.headerData) {
      assert.ok(row.offset >= headerMaxSize, `offset ${row.offset} should be >= ${headerMaxSize}`);
    }
  });
});
