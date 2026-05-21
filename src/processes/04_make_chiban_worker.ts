import workerpool from 'workerpool';

import { getAndStreamCSVDataForId } from '../lib/hub.js';
import { MachiAzaData } from '../lib/abr_data/machi_aza.js';
import { processCity } from './04_make_chiban_lib.js';

type ProcessCityArgs = {
  ma: MachiAzaData;
  machiAzaResultId: string;
  outDir: string;
};

let machiAzaByLgCodeCache: Map<string, MachiAzaData[]> | undefined;

async function loadMachiAzaIndex(id: string): Promise<Map<string, MachiAzaData[]>> {
  if (machiAzaByLgCodeCache) return machiAzaByLgCodeCache;
  const stream = getAndStreamCSVDataForId<MachiAzaData>(id);
  const index = new Map<string, MachiAzaData[]>();
  for await (const row of stream) {
    const list = index.get(row.lg_code) ?? [];
    list.push(row);
    index.set(row.lg_code, list);
  }
  machiAzaByLgCodeCache = index;
  return index;
}

async function processCityForWorker(args: ProcessCityArgs): Promise<void> {
  const index = await loadMachiAzaIndex(args.machiAzaResultId);
  const entries = index.get(args.ma.lg_code) ?? [];
  const machiAzaDataByCode = new Map(
    entries.map((ma) => [`${ma.lg_code}|${ma.machiaza_id}`, ma]),
  );
  await processCity(args.ma, machiAzaDataByCode, args.outDir);
}

workerpool.worker({
  processCity: processCityForWorker,
});
