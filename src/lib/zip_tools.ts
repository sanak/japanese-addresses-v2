import { Readable } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs/promises';
import unzipper, { Entry } from 'unzipper';

/**
 * A function to unzip a file that may or may not contain another zip file.
 * The zip file is extracted and each file is returned as a readable stream.
 */
export async function *unzipAndExtractZipFile(zipFile: Readable): AsyncGenerator<Entry> {
  const files = zipFile.pipe(unzipper.Parse({forceStream: true}));
  for await (const entry_ of files) {
    const entry = entry_ as Entry;
    if (entry.type === 'File' && entry.path.endsWith('.zip')) {
      yield *unzipAndExtractZipFile(entry);
    } else if (entry.type === 'File' && entry.path.endsWith('.csv')) {
      yield entry;
    } else {
      entry.autodrain();
    }
  }
}

export async function *unzipAndExtractZipBuffer(zipFile: Buffer): AsyncGenerator<Buffer & {path: string}> {
  const directory = await unzipper.Open.buffer(zipFile);
  for (const file of directory.files) {
    if (file.type === 'File' && file.path.endsWith('.zip')) {
      const content = await file.buffer();
      yield *unzipAndExtractZipBuffer(content);
    } else if (file.type === 'File' && file.path.endsWith('.csv')) {
      const content = await file.buffer();
      yield Object.assign(content, {path: file.path});
    }
  }
}

export async function unzipToFiles(zipBuffer: Buffer, outDir: string): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const usedNames = new Set<string>();
  for await (const entry of unzipAndExtractZipBuffer(zipBuffer)) {
    const base = path.basename(entry.path);
    let name = base;
    let n = 1;
    while (usedNames.has(name)) {
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      name = `${stem}_${n}${ext}`;
      n++;
    }
    usedNames.add(name);
    const dest = path.join(outDir, name);
    await fs.writeFile(dest, entry);
    written.push(dest);
  }
  return written;
}
