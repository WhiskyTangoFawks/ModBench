// MO2's rename of a plugin: its files and its line in every profile's plugin order, under every
// plugin order's lock, and put back if a write fails.

import { parse } from 'node:path';
import { refuse } from '../ports/refuse';
import { parsePlugins, pluginKey, renamePluginInText } from '../loadOrderFileCodec/pluginsText';
import { pluginCompanionRule, type PluginCompanionRule } from '../tables/gamePaths';
import { get, listDir, rename, undoAll, type Undo, withLock, write } from './files';
import type { FileOrigin, InstanceAdapter } from './instanceAdapter';
import { fileInFolder, originDir, pluginsFile, profilesDir } from './layout';
import { readOrAbsent, type Mo2Context } from './mo2Context';

export type Mo2PluginRename = Pick<InstanceAdapter, 'renamePlugin' | 'checkPluginRename'>;

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

const namedFile = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name);

async function entriesIn(folder: string): Promise<Entry[]> {
  const dirents = await readOrAbsent(() => listDir(folder), []);
  return dirents.map((d) => ({ name: d.name, isFolder: d.isDirectory() }));
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
    const profiles = (await readOrAbsent(() => listDir(profilesDir(instanceRoot)), [])).filter((d) => d.isDirectory());
    return profiles.map((d) => pluginsFile(instanceRoot, d.name)).sort();
  }

  // Everything the rename refuses, read before any write, so a refusal can come before the plugin
  // source moves.
  async function plan(orders: readonly string[], origin: FileOrigin, from: string, to: string, gameRelease: string | undefined) {
    const rule = pluginCompanionRule(gameRelease);
    if (rule === undefined) throw new Error(`No table of the files named for a plugin for the release ${gameRelease ?? 'of this game'}`);
    if (!namedFile(to)) throw new Error(`Not a valid plugin file name: "${to}"`);
    const folder = originDir(instanceRoot, origin);
    if (folder === undefined) throw notAFileOf(origin, from);
    return { lines: await renamedLines(orders, from, to), files: await moves(origin, folder, from, to, rule) };
  }

  return {
    async checkPluginRename(origin, from, to, gameRelease) {
      try {
        await plan(await orderFiles(), origin, from, to, gameRelease);
        return { applied: true };
      } catch (err) {
        return refuse(err);
      }
    },
    async renamePlugin(origin, from, to, gameRelease) {
      const orders = await orderFiles();
      await withLocks(orders, async () => {
        const { lines, files } = await plan(orders, origin, from, to, gameRelease);
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
