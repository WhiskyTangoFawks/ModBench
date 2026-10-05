// MO2's rename of a plugin: its files and its line in every profile's plugin order, under every
// plugin order's lock, and put back if a write fails.

import { extname } from 'node:path';
import { parsePlugins, pluginKey, renamePluginInText } from '../loadOrderFileCodec/pluginsText';
import { pluginCompanionsOf, type PluginCompanions } from '../tables/gamePaths';
import { get, listDir, rename, undoAll, type Undo, withLock, write } from './files';
import type { FileOrigin, InstanceAdapter } from './instanceAdapter';
import { fileInFolder, originDir, pluginsFile, profilesDir } from './layout';
import { readOrAbsent, type Mo2Context } from './mo2Context';

export type Mo2PluginRename = Pick<InstanceAdapter, 'renamePlugin'>;

const STRINGS_FOLDER = 'strings';
const STRINGS_EXTENSIONS = ['.strings', '.dlstrings', '.ilstrings'];

interface Move {
  readonly from: string;
  readonly to: string;
}

interface Entry {
  readonly name: string;
  readonly isFolder: boolean;
}

const stemOf = (plugin: string): string => plugin.slice(0, plugin.length - extname(plugin).length);

const sameName = (a: string, b: string): boolean => pluginKey(a) === pluginKey(b);

const notAFileOf = (origin: FileOrigin, name: string): Error =>
  new Error(`Not a file of ${origin.kind === 'mod' ? `mod "${origin.name}"` : 'Overwrite'}: "${name}"`);

const namedFile = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name);

async function entriesIn(folder: string): Promise<Entry[]> {
  const dirents = await readOrAbsent(() => listDir(folder), []);
  return dirents.map((d) => ({ name: d.name, isFolder: d.isDirectory() }));
}

// The plugin, its ini, its archives (`stem.ext`, `stem - Part.ext`) and its strings in each
// language, matched without case.
function namedForPlugin(
  names: readonly string[], stringsNames: readonly string[], plugin: string, companions: PluginCompanions,
): { root: string[]; strings: string[] } {
  const stem = pluginKey(stemOf(plugin));
  const archive = (name: string): boolean => {
    const key = pluginKey(name);
    const extension = companions.archiveExtension;
    return key === stem + extension || (key.startsWith(`${stem} - `) && key.endsWith(extension));
  };
  const strings = (name: string): boolean => companions.stringsLanguages.some((language) =>
    STRINGS_EXTENSIONS.some((extension) => pluginKey(name) === `${stem}_${pluginKey(language)}${extension}`));
  return {
    root: names.filter((name) => sameName(name, plugin) || pluginKey(name) === `${stem}.ini` || archive(name)),
    strings: stringsNames.filter(strings),
  };
}

interface Line {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

// The plugin order of each file that lists `from`, with its line renamed; a file that does not list
// it is left out, and one that lists `to` for another plugin refuses.
async function renamedLines(files: readonly string[], from: string, to: string): Promise<Line[]> {
  const lines: Line[] = [];
  for (const file of files) {
    const before = await readOrAbsent(() => get(file), undefined);
    const listed = before === undefined ? [] : parsePlugins(before);
    const line = listed.find((p) => sameName(p.name, from));
    if (before === undefined || line === undefined) continue;
    const other = listed.find((p) => sameName(p.name, to) && !sameName(p.name, from));
    if (other !== undefined) throw new Error(`Plugin already in plugins.txt: ${other.name}`);
    lines.push({ file, before, after: renamePluginInText(before, line.name, to) });
  }
  return lines;
}

function withLocks<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
  const [first, ...rest] = keys;
  return first === undefined ? task() : withLock(first, () => withLocks(rest, task));
}

export function mo2PluginRename(context: Mo2Context): Mo2PluginRename {
  const { instanceRoot } = context;

  async function moves(origin: FileOrigin, folder: string, from: string, to: string, companions: PluginCompanions): Promise<Move[]> {
    const root = await entriesIn(folder);
    const stringsFolder = root.find((entry) => entry.isFolder && pluginKey(entry.name) === STRINGS_FOLDER);
    const stringsPath = stringsFolder === undefined ? undefined : fileInFolder(folder, stringsFolder.name);
    const stringsEntries = stringsPath === undefined ? [] : await entriesIn(stringsPath);
    const named = namedForPlugin(
      root.filter((e) => !e.isFolder).map((e) => e.name), stringsEntries.filter((e) => !e.isFolder).map((e) => e.name), from, companions,
    );
    if (!named.root.some((name) => sameName(name, from))) {
      throw notAFileOf(origin, from);
    }
    const stem = stemOf(from).length;
    const newStem = stemOf(to);
    const moved = (inFolder: string, existing: readonly Entry[], names: readonly string[], target: (name: string) => string): Move[] =>
      names.map((name) => {
        const newName = target(name);
        const taken = existing.find((e) => sameName(e.name, newName) && !sameName(e.name, name) && e.name !== name);
        if (taken !== undefined) throw new Error(`The file "${fileInFolder(inFolder, taken.name)}" is in the way`);
        return { from: fileInFolder(inFolder, name), to: fileInFolder(inFolder, newName) };
      });
    return [
      ...moved(folder, root, named.root, (name) => (sameName(name, from) ? to : newStem + name.slice(stem))),
      ...(stringsPath === undefined ? [] : moved(stringsPath, stringsEntries, named.strings, (name) => newStem + name.slice(stem))),
    ];
  }

  return {
    async renamePlugin(origin, from, to, gameRelease) {
      const companions = pluginCompanionsOf(gameRelease);
      if (companions === undefined) throw new Error(`No table of the files named for a plugin for the release ${gameRelease ?? 'of this game'}`);
      if (!namedFile(to)) throw new Error(`Not a valid plugin file name: "${to}"`);
      const folder = originDir(instanceRoot, origin);
      if (folder === undefined) throw notAFileOf(origin, from);

      const profiles = (await readOrAbsent(() => listDir(profilesDir(instanceRoot)), [])).filter((d) => d.isDirectory());
      const orders = profiles.map((d) => pluginsFile(instanceRoot, d.name)).sort();
      await withLocks(orders, async () => {
        const lines = await renamedLines(orders, from, to);
        const files = await moves(origin, folder, from, to, companions);
        const undos: Undo[] = [];
        try {
          for (const move of files) {
            await rename(move.from, move.to);
            undos.unshift(() => rename(move.to, move.from));
          }
          for (const { file, before, after } of lines) {
            await write(file, after);
            undos.unshift(() => write(file, before));
          }
        } catch (err) {
          throw await undoAll(undos, err);
        }
      });
    },
  };
}
