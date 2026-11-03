import { access, constants } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { crc32Of } from '../fileContents/contentDigest';
import { errnoCode } from '../../ports/errno';
import type { GameFolder } from '../instanceAdapter';
import { versionResourceOf } from './versionResource';

/** What LOOT's conditions read of a file, by path relative to the Data folder (`../` leaves it). `winner` is where mod
 *  order provides the file, else it is the game folder's. A file not there answers `undefined` or `false`. */
export interface DataFileReads {
  /** The CRC-32 of the file's bytes. */
  dataFileChecksum(path: string, winner: string | undefined): Promise<number | undefined>;
  /** The File Version or Product Version of a Windows program; `undefined` for one with no version resource. */
  dataFileVersion(path: string, winner: string | undefined, field: 'file' | 'product'): Promise<string | undefined>;
  dataFileReadable(path: string, winner: string | undefined): Promise<boolean>;
}

const absent = (err: unknown): boolean => errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR';

export function dataFileReads(gameFolder: () => Promise<GameFolder>): DataFileReads {
  const located = async (path: string, winner: string | undefined): Promise<string> => {
    if (winner !== undefined) return winner;
    const folder = await gameFolder();
    if (folder.kind !== 'found') throw new Error('the game folder was not found');
    return resolve(join(folder.dataFolder, path));
  };
  const ifThere = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read();
    } catch (err) {
      if (absent(err)) return undefined;
      throw err;
    }
  };
  return {
    dataFileChecksum: async (path, winner) => ifThere(async () => parseInt(await crc32Of(await located(path, winner)), 16)),
    dataFileVersion: async (path, winner, field) => ifThere(async () => {
      const resource = await versionResourceOf(await located(path, winner));
      if (resource.kind === 'notAProgram') throw new Error(`${path} is not a Windows program`);
      if (resource.kind === 'noVersionResource') return undefined;
      return field === 'file' ? resource.fileVersion : resource.productVersion;
    }),
    dataFileReadable: async (path, winner) => {
      try {
        await access(await located(path, winner), constants.R_OK);
        return true;
      } catch (err) {
        if (absent(err)) return false;
        throw err;
      }
    },
  };
}
