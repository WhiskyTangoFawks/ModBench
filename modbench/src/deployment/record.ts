// What deploy wrote, per deployment folder: each file's path below the folder and the file it linked
// there. A file at that path that is still that file is deploy's; any other is the user's (ADR-0025).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { errnoCode } from '../ports/errno';

/** A file deploy linked: its path below the deployment folder, `/`-separated, and its file ID. */
export interface Written {
  readonly path: string;
  readonly ino: string;
}

/** The `plugins.txt` deploy wrote: its absolute path and file ID, and where it renamed the file it found there. */
export interface WrittenPluginsTxt {
  readonly path: string;
  readonly ino: string;
  readonly renamedTo?: string;
}

/** What deploy wrote for one deployment folder. */
interface Recorded {
  readonly files: readonly Written[];
  readonly pluginsTxt?: WrittenPluginsTxt;
}

type ByFolder = Partial<Record<string, Recorded>>;

const isWritten = (entry: unknown): entry is Written =>
  typeof entry === 'object' && entry !== null && 'path' in entry && typeof entry.path === 'string' && 'ino' in entry && typeof entry.ino === 'string';

const isRecorded = (entry: unknown): entry is Recorded =>
  typeof entry === 'object' && entry !== null && 'files' in entry && Array.isArray(entry.files) && entry.files.every(isWritten) &&
  (!('pluginsTxt' in entry) || (isWritten(entry.pluginsTxt) && (!('renamedTo' in entry.pluginsTxt) || typeof entry.pluginsTxt.renamedTo === 'string')));

function parsed(text: string, file: string): ByFolder {
  const record: unknown = JSON.parse(text);
  if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error(`${file} holds no record of a deployment`);
  return Object.fromEntries(Object.entries(record).map(([folder, written]) => {
    if (!isRecorded(written)) throw new Error(`${file} holds no record of what deploy wrote to ${folder}`);
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

export interface DeploymentRecord {
  of(folder: string): Promise<Recorded>;
  write(folder: string, recorded: Recorded): Promise<void>;
}

// Windows matches a path without case.
const keyOf = (folder: string): string => (process.platform === 'win32' ? resolve(folder).toLowerCase() : resolve(folder));

/** The record of every deployment folder of one instance, kept in one file. */
export function recordIn(file: string): DeploymentRecord {
  return {
    async of(folder) {
      return (await readRecord(file))[keyOf(folder)] ?? { files: [] };
    },
    async write(folder, recorded) {
      const record = { ...(await readRecord(file)), [keyOf(folder)]: recorded };
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(record));
      await rename(temp, file);
    },
  };
}
