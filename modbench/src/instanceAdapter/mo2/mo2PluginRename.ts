// MO2's rename of a plugin: its files and its line in every profile's plugins.txt and loadorder.txt, under every
// plugin order's lock, and put back if a write fails.

import { basename, parse } from 'node:path';
import { parsePlugins, pluginKey, renamePluginInText } from '../../loadOrderFileCodec/pluginsText';
import { present } from '../../ports/present';
import { pluginCompanionRule, type PluginCompanionRule } from '../../tables/gamePaths';
import { get, ignoreSkippedLink, listEntries, listFolders, readOrAbsent, rename, undoAll, type Undo, withLock, write } from '../files';
import { fileInFolder, isBareName, type FileOrigin, InstanceAdapter } from '../instanceAdapter';
import { pluginOrderFiles, profilesDir } from './layout';
import type { ReadingSource } from '../instanceReading';
import { originFolder, type Mo2Context } from './mo2Context';

type Mo2PluginRename = Pick<InstanceAdapter, 'renamePlugin' | 'originHoldsPlugin'>;

interface Move {
  readonly from: string;
  readonly to: string;
}

interface Entry {
  readonly name: string;
  readonly isFolder: boolean;
}

const sameName = (a: string, b: string): boolean => pluginKey(a) === pluginKey(b);

const notAFileOf = (origin: FileOrigin, name: string): Error =>
  new Error(`Not a file of ${origin.kind === 'mod' ? `mod "${origin.name}"` : 'Overwrite'}: "${name}"`);

async function entriesIn(folder: string): Promise<Entry[]> {
  const unfollowable: Entry[] = [];
  const dirents = await readOrAbsent(() => listEntries(folder, (link) => unfollowable.push({ name: basename(link), isFolder: false })), []);
  return [...dirents.map((d) => ({ name: d.name, isFolder: d.isDirectory })), ...unfollowable];
}

interface Line {
  readonly file: string;
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
    lines.push({ file, after: renamePluginInText(before, line.name, to) });
  }
  return lines;
}

function withLocks<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
  const [first, ...rest] = keys;
  return first === undefined ? task() : withLock(first, () => withLocks(rest, task));
}

export function mo2PluginRename(context: Mo2Context, source: ReadingSource): Mo2PluginRename {
  const { instanceRoot } = context;

  // Each file of a folder that `named` picks, renamed by `target`. Two files that land on one name
  // refuse, as does one that lands on a file already there under another name.
  function movesIn(folder: string, entries: readonly Entry[], named: (name: string) => boolean, target: (name: string) => string): Move[] {
    const moves = entries.filter((e) => !e.isFolder && named(e.name)).map((e) => ({ name: e.name, newName: target(e.name) }));
    for (const { name, newName } of moves) {
      const taken = entries.find((e) => sameName(e.name, newName) && !moves.some((m) => m.name === e.name));
      const twin = moves.find((m) => m.name !== name && sameName(m.newName, newName));
      if (taken !== undefined || twin !== undefined) throw new Error(`The file "${fileInFolder(folder, taken?.name ?? newName)}" is in the way`);
    }
    return moves.map(({ name, newName }) => ({ from: fileInFolder(folder, name), to: fileInFolder(folder, newName) }));
  }

  async function moves(origin: FileOrigin, folder: string, from: string, to: string, rule: PluginCompanionRule): Promise<Move[]> {
    const root = await entriesIn(folder);
    const stringsFolder = root.find((e) => e.isFolder && sameName(e.name, rule.stringsFolder));
    const stringsPath = stringsFolder === undefined ? undefined : fileInFolder(folder, stringsFolder.name);
    const stringsEntries = stringsPath === undefined ? [] : await entriesIn(stringsPath);
    const stemLength = parse(from).name.length;
    const newStem = parse(to).name;
    const keepingTail = (name: string): string => newStem + name.slice(stemLength);
    const ownFile = (name: string): boolean => sameName(name, from);
    if (!root.some((e) => !e.isFolder && ownFile(e.name))) throw notAFileOf(origin, from);
    return [
      ...movesIn(folder, root, (name) => ownFile(name) || rule.inRoot(from, name), (name) => (ownFile(name) ? to : keepingTail(name))),
      ...(stringsPath === undefined ? [] : movesIn(stringsPath, stringsEntries, (name) => rule.inStringsFolder(from, name), keepingTail)),
    ];
  }

  async function orderFiles(): Promise<string[]> {
    const profiles = await readOrAbsent(() => listFolders(profilesDir(instanceRoot), ignoreSkippedLink), []);
    return profiles.sort().flatMap((name) => pluginOrderFiles(instanceRoot, name));
  }

  // Everything the rename refuses, read before any write.
  async function plan(orders: readonly string[], origin: FileOrigin, from: string, to: string) {
    const { gameRelease } = await source.settings();
    const rule = present(pluginCompanionRule(gameRelease), `the files named for a plugin of ${gameRelease}`);
    if (!isBareName(to)) throw new Error(`Not a valid plugin file name: "${to}"`);
    const folder = await originFolder(context, origin, 'list');
    if (folder === undefined) throw notAFileOf(origin, from);
    return { lines: await renamedLines(orders, from, to), files: await moves(origin, folder, from, to, rule) };
  }

  return {
    async originHoldsPlugin(origin, name) {
      const folder = await originFolder(context, origin, 'list');
      return folder !== undefined && (await entriesIn(folder)).some((entry) => !entry.isFolder && sameName(entry.name, name));
    },

    async renamePlugin(origin, from, to) {
      const orders = await orderFiles();
      await withLocks(orders, async () => {
        const { lines, files } = await plan(orders, origin, from, to);
        const undos: Undo[] = [];
        try {
          for (const move of files) {
            await rename(move.from, move.to);
            undos.unshift(() => rename(move.to, move.from));
          }
          for (const { file, after } of lines) {
            await write(file, after);
            undos.unshift(async () => write(file, renamePluginInText(await get(file), to, from)));
          }
        } catch (err) {
          throw await undoAll(undos, err);
        }
      });
    },
  };
}
