// What deploy wrote, per deployment folder: each file's path below the folder and the file it linked
// there. A file at that path that is still that file is deploy's; any other is the user's (ADR-0025).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errnoCode } from '../ports/errno';

/** A file deploy linked: its path below the deployment folder, `/`-separated, and its file ID. */
export interface Written {
  readonly path: string;
  readonly ino: string;
}

type ByFolder = Partial<Record<string, readonly Written[]>>;

const isWritten = (entry: unknown): entry is Written =>
  typeof entry === 'object' && entry !== null && 'path' in entry && typeof entry.path === 'string' && 'ino' in entry && typeof entry.ino === 'string';

function parsed(text: string, file: string): ByFolder {
  const record: unknown = JSON.parse(text);
  if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error(`${file} holds no record of a deployment`);
  return Object.fromEntries(Object.entries(record).map(([folder, written]) => {
    if (!Array.isArray(written) || !written.every(isWritten)) throw new Error(`${file} holds no record of what deploy wrote to ${folder}`);
    return [folder, written];
  }));
}

async function readRecord(file: string): Promise<ByFolder> {
  try {
    return parsed(await readFile(file, 'utf8'), file);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return {};
    throw err;
  }
}

/** The record of every deployment folder of one instance, kept in one file. */
export function recordIn(file: string) {
  return {
    async of(folder: string): Promise<readonly Written[]> {
      return (await readRecord(file))[folder] ?? [];
    },
    async write(folder: string, written: readonly Written[]): Promise<void> {
      const record = { ...(await readRecord(file)), [folder]: written };
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(record));
      await rename(temp, file);
    },
  };
}
