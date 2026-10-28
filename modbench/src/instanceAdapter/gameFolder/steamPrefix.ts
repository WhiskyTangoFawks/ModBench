import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { errnoCode } from '../../ports/errno';
import { steamLibraries } from './gamePathDetector';
import { shortcutsAt, type Shortcut } from './steamShortcuts';

/** The Proton prefix of a non-Steam game in Steam, or why there is none. */
export type NonSteamPrefix = { readonly prefix: string } | { readonly why: string };

async function ifThere<T>(read: Promise<T>, otherwise: T): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return otherwise;
    throw err;
  }
}

const isWithin = (folder: string, path: string): boolean => {
  const below = relative(resolve(folder), resolve(path));
  return !below.startsWith('..') && !isAbsolute(below);
};

async function shortcutsUnder(steamRoot: string): Promise<Shortcut[]> {
  const users = join(steamRoot, 'userdata');
  const found: Shortcut[] = [];
  for (const user of await ifThere(readdir(users), [])) found.push(...await shortcutsAt(join(users, user, 'config', 'shortcuts.vdf')));
  return found;
}

/** The prefix, in any of Steam's libraries, of the non-Steam game whose program is in `folder`. `steamRoot` is undefined
 *  where Modbench knows no Steam. */
export async function nonSteamPrefixRunning(steamRoot: string | undefined, folder: string): Promise<NonSteamPrefix> {
  if (steamRoot === undefined) return { why: 'Modbench found no Steam' };
  const running = (await shortcutsUnder(steamRoot)).filter(({ exe }) => isWithin(folder, exe));
  const appId = running.find((shortcut) => shortcut.appId !== undefined)?.appId;
  if (appId === undefined) {
    const [noId] = running;
    return { why: noId === undefined ? `no non-Steam game in Steam runs a program in ${folder}` : `Steam's shortcut for ${noId.exe} holds no appid` };
  }
  const prefixIn = (library: string): string => join(library, 'steamapps', 'compatdata', String(appId), 'pfx');
  for (const library of await steamLibraries(steamRoot)) {
    if ((await ifThere(stat(prefixIn(library)), undefined))?.isDirectory()) return { prefix: prefixIn(library) };
  }
  return { why: `Steam has made no prefix at ${prefixIn(steamRoot)} yet` };
}
