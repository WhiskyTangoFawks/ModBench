// A file is written whole to a temp beside it, then renamed over it, so no reader meets it half-written.

import { join } from 'node:path';
import { errnoCode } from '../ports/errno';

const TEMP_PREFIX = '.medit_tmp_';

/** Whether `name` is a temp that Modbench or mEdit left in an instance folder: never a mod's file. */
export const isOwnTemp = (name: string): boolean => name.startsWith(TEMP_PREFIX);

// The prefix of a temp this process names, `.medit_tmp_<pid>_`: the process id lets any writer tell a leftover from a live temp.
export const ownTempPrefix = (folder: string, kind: string): string => join(folder, `${TEMP_PREFIX}${process.pid}_${kind}`);

/** The process that named the temp `tempName`; undefined when its name holds none. */
export function tempOwner(tempName: string): number | undefined {
  const id = Number(tempName.slice(TEMP_PREFIX.length).split('_')[0] || Number.NaN);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

// Windows refuses to rename over a file another program holds open, as git's sed, an antivirus scan or another write
// does for moments. Doubling from 10 ms, the last try comes about 2.5 s after the first.
const BUSY_CODES = ['EPERM', 'EACCES', 'EBUSY'];
const RETRIES = 8;
const FIRST_WAIT_MS = 10;

/** Renames `from` over `to`, trying again on Windows while another program holds `to`. Rejects with the last refusal. */
export async function renameOver(
  rename: (from: string, to: string) => Promise<void>, from: string, to: string, platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (let retry = 0; ; retry++) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (platform !== 'win32' || retry === RETRIES || !BUSY_CODES.includes(errnoCode(err) ?? '')) throw err;
      await new Promise((resolve) => setTimeout(resolve, FIRST_WAIT_MS * 2 ** retry));
    }
  }
}
