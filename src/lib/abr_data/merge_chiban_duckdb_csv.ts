import { DuckDBInstance } from '@duckdb/node-api';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ChibanDuckdbLifecycle = 'shared' | 'percity';

export interface ChibanDuckdbCtx {
  lifecycle: ChibanDuckdbLifecycle;
  instance?: DuckDBInstance;
  tempRoot: string;
}

/**
 * 04_make_chiban の main() 先頭で 1 度呼ぶ。lifecycle に応じ instance を生成または空 ctx を返す。
 * Phase 1: percity のみサポート。shared は Phase 2 で実装。
 */
export async function createChibanDuckdbCtx(
  lifecycle: ChibanDuckdbLifecycle,
): Promise<ChibanDuckdbCtx> {
  if (lifecycle !== 'shared' && lifecycle !== 'percity') {
    throw new Error(
      `createChibanDuckdbCtx: unknown lifecycle "${String(lifecycle)}", expected 'shared' | 'percity'`,
    );
  }
  if (lifecycle === 'shared') {
    throw new Error(
      `createChibanDuckdbCtx: shared lifecycle is not yet implemented (Phase 2)`,
    );
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chiban-duckdb-csv-'));
  return { lifecycle, instance: undefined, tempRoot };
}

/**
 * 04_make_chiban の main() 末尾で 1 度呼ぶ。instance を close し tempRoot を recursive 削除。
 * 同じ ctx に対して複数回呼ばれても (rm が ENOENT を投げないので) 安全。
 */
export async function closeChibanDuckdbCtx(ctx: ChibanDuckdbCtx): Promise<void> {
  if (ctx.instance) {
    try { ctx.instance.closeSync(); } catch { /* ignore */ }
    ctx.instance = undefined;
  }
  await fs.rm(ctx.tempRoot, { recursive: true, force: true }).catch((e: unknown) => {
    console.warn(`closeChibanDuckdbCtx: tempRoot cleanup failed: ${ctx.tempRoot}`, e);
  });
}
