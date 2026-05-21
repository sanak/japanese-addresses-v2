#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import cliProgress from 'cli-progress';

import { getHubItemsByQuery, findResultByTypeAndArea, getAndParseCSVDataForId } from '../lib/hub.js';
import { MachiAzaData } from '../lib/abr_data/machi_aza.js';
import { processCity } from './04_make_chiban_lib.js';

const CONCURRENCY = parseInt(process.env.CHIBAN_CONCURRENCY ?? '4', 10);

async function runCitiesWithPromiseRace(
  machiAzas: MachiAzaData[],
  machiAzaDataByCode: Map<string, MachiAzaData>,
  outDir: string,
  progress: cliProgress.SingleBar,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const ma of machiAzas) {
    const p: Promise<void> = processCity(ma, machiAzaDataByCode, outDir)
      .finally(() => {
        executing.delete(p);
        progress.increment();
      });
    executing.add(p);
    if (executing.size >= CONCURRENCY) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

async function main(argv: string[]) {
  const outDir = argv[2] || path.join(import.meta.dirname, '..', '..', 'out', 'api');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('事前準備: 町字データを取得中...');
  const machiAzaResults = await getHubItemsByQuery('町字マスター', '全国レベル');
  const machiAzaResult = findResultByTypeAndArea(machiAzaResults.features, '町字マスター', '全国');
  if (!machiAzaResult) {
    throw new Error(`「全国 町字マスター」データセットが見つかりませんでした`);
  }
  const machiAzaData = await getAndParseCSVDataForId<MachiAzaData>(machiAzaResult.properties.id);
  const machiAzaDataByCode = new Map(machiAzaData.map((ma) => [
    `${ma.lg_code}|${ma.machiaza_id}`,
    ma
  ]));

  const seenLgCodes = new Set<string>();
  const machiAzas: MachiAzaData[] = [];
  for (const ma of machiAzaData) {
    if (seenLgCodes.has(ma.lg_code)) continue;
    seenLgCodes.add(ma.lg_code);
    machiAzas.push(ma);
  }
  console.log('事前準備: 町字データを取得しました');

  const progress = new cliProgress.SingleBar({
    format: ' {bar} {percentage}% | ETA: {eta_formatted} | {value}/{total}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    etaBuffer: 30,
    fps: 2,
    noTTYOutput: true,
  });
  progress.start(machiAzas.length, 0);
  try {
    await runCitiesWithPromiseRace(machiAzas, machiAzaDataByCode, outDir, progress);
  } finally {
    progress.stop();
  }
}

export default main;
