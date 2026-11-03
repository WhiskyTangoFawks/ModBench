import { access, constants, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { crc32Of } from '../fileContents/contentDigest';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
import type { FileAnswer } from '../../sortingRules/lootConditions';
import type { GameFolder } from '../instanceAdapter';
import { versionResourceOf } from './versionResource';

/** What LOOT's conditions read of a file by path relative to the Data folder (`../` leaves it). `winner` is where mod
 *  order provides it, else the game folder's, found in any case. A file not there answers `undefined`/`false`. */
export interface DataFileReads {
  /** The CRC-32 of the file's bytes. */
  dataFileChecksum(path: string, winner: string | undefined): Promise<FileAnswer<number | undefined>>;
  /** The File Version or Product Version of a Windows program; `undefined` for one with no version number. */
  dataFileVersion(path: string, winner: string | undefined, field: 'file' | 'product'): Promise<FileAnswer<string | undefined>>;
  dataFileReadable(path: string, winner: string | undefined): Promise<FileAnswer<boolean>>;
}

const absent = (err: unknown): boolean => errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR';

const read = <T>(value: T): FileAnswer<T> => ({ kind: 'read', value });
const unreadable = (why: string): { kind: 'unreadable'; why: string } => ({ kind: 'unreadable', why });

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

// A Linux file system tells case apart where the game does not, so each segment is found in any case.
async function inAnyCase(base: string, relative: string): Promise<string> {
  let at = base;
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    const exact = segment === '..' ? dirname(at) : join(at, segment);
    if (segment === '..' || await exists(exact)) {
      at = exact;
      continue;
    }
    const names = await readdir(at).catch(() => []);
    at = join(at, names.find((name) => name.toLowerCase() === segment.toLowerCase()) ?? segment);
  }
  return at;
}

export function dataFileReads(gameFolder: () => Promise<GameFolder>): DataFileReads {
  const located = async (path: string, winner: string | undefined): Promise<{ at: string } | { why: string }> => {
    if (winner !== undefined) return { at: winner };
    const folder = await gameFolder();
    return folder.kind === 'found' ? { at: await inAnyCase(folder.dataFolder, path) } : { why: 'the game folder was not found' };
  };
  const reading = async <T>(path: string, winner: string | undefined, none: T, use: (at: string) => Promise<T>): Promise<FileAnswer<T>> => {
    const found = await located(path, winner);
    if ('why' in found) return unreadable(found.why);
    try {
      return read(await use(found.at));
    } catch (err) {
      return absent(err) ? read(none) : unreadable(errorMessage(err));
    }
  };
  return {
    dataFileChecksum: (path, winner) => reading<number | undefined>(path, winner, undefined, async (at) => parseInt(await crc32Of(at), 16)),
    dataFileVersion: async (path, winner, field) => {
      const found = await located(path, winner);
      if ('why' in found) return unreadable(found.why);
      try {
        const resource = await versionResourceOf(found.at);
        if (resource.kind === 'notAProgram') return unreadable(`${path} is not a Windows program`);
        if (resource.kind === 'noVersionResource') return read(undefined);
        const version = field === 'file' ? resource.fileVersion : resource.productVersion;
        return read(version === '' ? undefined : version);
      } catch (err) {
        return absent(err) ? read(undefined) : unreadable(errorMessage(err));
      }
    },
    dataFileReadable: (path, winner) => reading(path, winner, false, (at) => access(at, constants.R_OK).then(() => true)),
  };
}
