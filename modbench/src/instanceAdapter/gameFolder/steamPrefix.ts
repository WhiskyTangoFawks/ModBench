import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readOrAbsent, readOrReason } from '../files';
import { steamLibraries } from './gamePathDetector';
import { shortcutsAt, type Shortcut } from './steamShortcuts';

/** The Proton prefix of a non-Steam game in Steam, or why there is none. */
export type NonSteamPrefix = { readonly prefix: string } | { readonly why: string };

async function realPathOf(path: string): Promise<string> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  return readOrAbsent(() => realpath(absolute), undefined).then(async (real) => real ?? (parent === absolute ? absolute : join(await realPathOf(parent), basename(absolute))));
}

async function isWithin(folder: string, path: string): Promise<boolean> {
  const below = relative(await realPathOf(folder), await realPathOf(path));
  return !below.startsWith('..') && !isAbsolute(below);
}

async function shortcutsUnder(steamRoot: string): Promise<Shortcut[]> {
  const users = join(steamRoot, 'userdata');
  const found: Shortcut[] = [];
  for (const user of await readOrAbsent(() => readdir(users), [])) found.push(...await shortcutsAt(join(users, user, 'config', 'shortcuts.vdf')));
  return found;
}

async function runningIn(steamRoot: string, folder: string): Promise<Shortcut[]> {
  const running: Shortcut[] = [];
  for (const shortcut of await shortcutsUnder(steamRoot)) if (await isWithin(folder, shortcut.exe)) running.push(shortcut);
  return running;
}

async function prefixOfShortcut(steamRoot: string, appId: number): Promise<NonSteamPrefix> {
  const prefixIn = (library: string): string => join(library, 'steamapps', 'compatdata', String(appId), 'pfx');
  for (const library of await steamLibraries(steamRoot)) {
    if ((await readOrAbsent(() => stat(prefixIn(library)), undefined))?.isDirectory()) return { prefix: prefixIn(library) };
  }
  return { why: `Steam has made no prefix at ${prefixIn(steamRoot)} yet` };
}

async function prefixRunningIn(steamRoot: string, folder: string): Promise<NonSteamPrefix> {
  const running = await runningIn(steamRoot, folder);
  const [first] = running;
  if (first === undefined) return { why: `no non-Steam game in Steam runs a program in ${folder}` };
  if (new Set(running.map(({ appId, exe }) => appId ?? exe)).size > 1) {
    return { why: `several non-Steam games in Steam run programs in ${folder}: ${running.map(({ exe }) => exe).join(', ')}` };
  }
  const appId = running.find((shortcut) => shortcut.appId !== undefined)?.appId;
  return appId === undefined ? { why: `Steam's shortcut for ${first.exe} holds no appid` } : prefixOfShortcut(steamRoot, appId);
}

/** The prefix, in any of Steam's libraries, of the one non-Steam game whose program is in `folder`. `steamRoot` is undefined
 *  where Modbench looks for no Steam. */
export async function nonSteamPrefixRunning(steamRoot: string | undefined, folder: string): Promise<NonSteamPrefix> {
  if (steamRoot === undefined) return { why: 'Modbench looks for no Steam on this platform' };
  if (await readOrAbsent(() => stat(steamRoot), undefined) === undefined) return { why: `Modbench found no Steam at ${steamRoot}` };
  const found = await readOrReason(() => prefixRunningIn(steamRoot, folder));
  return found.kind === 'read' ? found.answer : { why: `Steam cannot be read: ${found.reason}` };
}
