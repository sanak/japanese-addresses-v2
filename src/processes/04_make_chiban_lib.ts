import fs from 'node:fs';
import path from 'node:path';

import { getHubItemsByQuery, findResultByTypeAndArea, getAndStreamCSVDataForId } from '../lib/hub.js';
import { machiAzaName, SingleChiban, SingleMachiAza } from '../data.js';
import { projectABRData } from '../lib/proj.js';
import { MachiAzaData } from '../lib/abr_data/machi_aza.js';
import { rawToMachiAza } from './02_machi_aza.js';
import { ChibanData, ChibanPosData } from '../lib/abr_data/chiban.js';
import { mergeDataLeftJoin } from '../lib/abr_data/index.js';

export const HEADER_CHUNK_SIZE = 50_000;

export type ChibanApi = {
  machiAza: SingleMachiAza;
  chibans: SingleChiban[];
}[];

export type HeaderRow = {
  name: string;
  offset: number;
  length: number;
}

export function serializeApiDataTxt(apiData: ChibanApi): { headerIterations: number, headerData: HeaderRow[], data: Buffer } {
  const outSections: Buffer[] = [];
  for ( const { machiAza, chibans } of apiData ) {
    const lines: string[] = [
      `地番,${machiAzaName(machiAza)}`,
      `prc_num1,prc_num2,prc_num3,lng,lat`,
    ];
    for (const chiban of chibans) {
      lines.push(`${chiban.prc_num1},${chiban.prc_num2 || ''},${chiban.prc_num3 || ''},${chiban.point?.[0] || ''},${chiban.point?.[1] || ''}`);
    }
    outSections.push(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  }

  const createHeader = (iterations = 1): { iterations: number, data: HeaderRow[], buffer: Buffer } => {
    let header = '';
    const headerMaxSize = HEADER_CHUNK_SIZE * iterations;
    let lastBytePos = headerMaxSize;
    const headerData: HeaderRow[] = [];
    for (const [index, section] of outSections.entries()) {
      const ma = apiData[index].machiAza;

      header += `${machiAzaName(ma)},${lastBytePos},${section.length}\n`;
      headerData.push({
        name: machiAzaName(ma),
        offset: lastBytePos,
        length: section.length,
      });

      lastBytePos += section.length;
    }
    const headerBuf = Buffer.from(header + '=END=\n', 'utf8');
    if (headerBuf.length > headerMaxSize) {
      return createHeader(iterations + 1);
    } else {
      const padding = Buffer.alloc(headerMaxSize - headerBuf.length);
      padding.fill(0x20);
      return {
        iterations,
        data: headerData,
        buffer: Buffer.concat([headerBuf, padding])
      };
    }
  };

  const header = createHeader();
  return {
    headerIterations: header.iterations,
    headerData: header.data,
    data: Buffer.concat([header.buffer, ...outSections]),
  };
}

export async function outputChibanData(outDir: string, outFilename: string, apiData: ChibanApi) {
  if (apiData.length === 0) {
    return;
  }

  const outFileTXT = path.join(outDir, 'ja', outFilename + '-地番.txt');
  const txt = serializeApiDataTxt(apiData);
  await fs.promises.mkdir(path.dirname(outFileTXT), { recursive: true });
  await fs.promises.writeFile(outFileTXT, txt.data);

  console.log(`${outFilename}: ${apiData.length.toString(10).padEnd(4, ' ')} 件の町字の地番を出力した`);
}

export async function processCity(
  ma: MachiAzaData,
  machiAzaDataByCode: Map<string, MachiAzaData>,
  outDir: string,
): Promise<void> {
  let area = `${ma.pref} ${ma.county}${ma.city}`;
  if (ma.ward !== '') {
    area += ma.ward;
  }
  const searchQuery = `${area} 地番マスター`;
  const results = await getHubItemsByQuery(`${area} 地番マスター`, '市区町村レベル', ma.pref);
  const chibanDataRef = findResultByTypeAndArea(results.features, '地番マスター', area);
  const chibanPosDataRef = findResultByTypeAndArea(results.features, '地番マスター位置参照拡張', area);
  if (!chibanDataRef) {
    console.error(`Insufficient data found for ${searchQuery} (地番マスター)`);
    return;
  }

  const mainStream = getAndStreamCSVDataForId<ChibanData>(chibanDataRef.properties.id);
  const posStream = chibanPosDataRef ?
    getAndStreamCSVDataForId<ChibanPosData>(chibanPosDataRef.properties.id)
    :
    // 位置参照拡張データが無い場合もある
    (async function*() {})();

  const rawData = mergeDataLeftJoin(mainStream, posStream, ['lg_code', 'machiaza_id', 'prc_id'], true);

  let currentMachiAza: MachiAzaData | undefined = undefined;
  const apiData: ChibanApi = [];
  let currentChibanList: SingleChiban[] = [];
  for await (const raw of rawData) {
    const maEntry = machiAzaDataByCode.get(`${raw.lg_code}|${raw.machiaza_id}`);
    if (!maEntry) {
      continue;
    }
    if (currentMachiAza && (currentMachiAza.machiaza_id !== maEntry.machiaza_id || currentMachiAza.lg_code !== maEntry.lg_code)) {
      apiData.push({
        machiAza: rawToMachiAza(currentMachiAza),
        chibans: currentChibanList,
      });
      currentChibanList = [];
      currentMachiAza = maEntry;
    }
    if (!currentMachiAza) {
      currentMachiAza = maEntry;
    }

    currentChibanList.push({
      prc_num1: raw.prc_num1,
      prc_num2: raw.prc_num2 !== '' ? raw.prc_num2 : undefined,
      prc_num3: raw.prc_num3 !== '' ? raw.prc_num3 : undefined,
      point: 'rep_srid' in raw ? projectABRData(raw) : undefined,
    });
  }
  if (currentMachiAza && currentChibanList.length > 0) {
    apiData.push({
      machiAza: rawToMachiAza(currentMachiAza),
      chibans: currentChibanList,
    });
  }
  await outputChibanData(outDir, path.join(
    ma.pref,
    `${ma.county}${ma.city}${ma.ward}`,
  ), apiData);
}
