// MO2's rename of a plugin: its files, its line in every profile's plugins.txt and loadorder.txt, and its names in the
// userlist, under every plugin order's lock, and put back if a write fails.

import { basename } from 'node:path';
import { stripBom } from '../../loadOrderFileCodec/lineScan';
import { parsePlugins, pluginKey, renamePluginInText } from '../../loadOrderFileCodec/pluginsText';
import { errorMessage } from '../../ports/errorMessage';
import { present } from '../../ports/present';
import { ruleFilePluginNames } from '../../sortingRules/lootMetadata';
import { COMMITTED, namesPlugin, NO_FILE_CHANGES, placeIn, spliced, type SymbolOwner } from '../../symbolNames/symbolNames';
import { namesIn, ruleFileNames } from './mo2PluginReferences';
import { pluginCompanionRule, type PluginCompanionRule } from '../../tables/gamePaths';
import { get, listEntries, readOrAbsent, rename, undoAll, type Undo, withLock, write } from '../files';
import { fileInFolder, fileOriginOfPlugin, isBareName, type FileOrigin, InstanceAdapter } from '../instanceAdapter';
import { everyPluginOrderFile, sortingRuleFilePaths } from './layout';
import type { ReadingSource } from '../instanceReading';
import { originFolder, type Mo2Context } from './mo2Context';

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

interface RuleFileRename {
  readonly after?: string;
  readonly cannotFollow: readonly string[];
}

const lineOf = (file: string, text: string, at: number): number => placeIn(file, text, at, at).start.line + 1;

// A name keeps the quoting it is written in; a rename that would read back otherwise is left as it was.
const spelledAt = (text: string, start: number, name: string): string => {
  const quote = text.charAt(start - 1);
  if (quote === '"') return JSON.stringify(name).slice(1, -1);
  return quote === '\'' ? name.replace(/'/g, '\'\'') : name;
};

function userlistRenamedIn(file: string, text: string, from: string, to: string): RuleFileRename {
  const read = stripBom(text);
  const names = ruleFilePluginNames(read);
  if ('refused' in names) return { cannotFollow: [`${file}: ${names.refused}`] };
  const named = names.filter(({ name }) => sameName(name, from));
  if (named.length === 0) return { cannotFollow: [] };
  const renamed = spliced(read, named, (start) => spelledAt(read, start, to));
  const reread = ruleFilePluginNames(renamed);
  const expected = names.map(({ name }) => (sameName(name, from) ? to : name));
  if ('refused' in reread || reread.map(({ name }) => name).join('\n') !== expected.join('\n')) {
    return { cannotFollow: named.map(({ start }) => `${file}, line ${String(lineOf(file, read, start))}: names ${from} where ${to} does not read as written.`) };
  }
  return { after: text.slice(0, text.length - read.length) + renamed, cannotFollow: [] };
}

async function userlistRenamed(file: string, from: string, to: string): Promise<RuleFileRename> {
  try {
    const text = await readOrAbsent(() => get(file), undefined);
    return text === undefined ? { cannotFollow: [] } : userlistRenamedIn(file, text, from, to);
  } catch (err) {
    return { cannotFollow: [`${file}: ${errorMessage(err)}`] };
  }
}

// LOOT's metadata update replaces the masterlist and the prelude, so a name there stays as it is.
async function leftInLootsFiles(files: readonly string[], from: string): Promise<string[]> {
  const read = await Promise.all(files.map((file) => namesIn(file, ruleFileNames, from)));
  return read.flatMap(({ references, leftOut }) => [
    ...references.map(({ place }) => `${place.file}, line ${String(place.start.line + 1)}: LOOT's metadata names ${from}, and its update replaces the file.`),
    ...leftOut,
  ]);
}

// Each move and each file's new text, or, when one fails, none of them.
async function writtenWhole(moves: readonly Move[], texts: readonly Line[]): Promise<void> {
  const undos: Undo[] = [];
  try {
    for (const move of moves) {
      await rename(move.from, move.to);
      undos.unshift(() => rename(move.to, move.from));
    }
    for (const { file, after } of texts) {
      const before = await get(file);
      await write(file, after);
      undos.unshift(() => write(file, before));
    }
  } catch (err) {
    throw await undoAll(undos, err);
  }
}

function withLocks<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
  const [first, ...rest] = keys;
  return first === undefined ? task() : withLock(first, () => withLocks(rest, task));
}

export function mo2PluginRename(context: Mo2Context, source: ReadingSource): Pick<InstanceAdapter, 'originHoldsPlugin'> & { readonly planRename: SymbolOwner['plan'] } {
  const { instanceRoot } = context;
  const ruleFiles = sortingRuleFilePaths(instanceRoot);

  // Each file of a folder that `target` renames. Two files that land on one name refuse, as does one that
  // lands on a file already there under another name.
  function movesIn(folder: string, entries: readonly Entry[], target: (name: string) => string | undefined): Move[] {
    const moves = entries.flatMap((e) => {
      const newName = e.isFolder ? undefined : target(e.name);
      return newName === undefined ? [] : [{ name: e.name, newName }];
    });
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
    if (!root.some((e) => !e.isFolder && sameName(e.name, from))) throw notAFileOf(origin, from);
    return [
      ...movesIn(folder, root, (name) => rule.renamedWith(from, name, to)),
      ...(stringsPath === undefined ? [] : movesIn(stringsPath, stringsEntries, (name) => rule.renamedWith(from, `${rule.stringsFolder}/${name}`, to)?.split('/')[1])),
    ];
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

  // A line and the rule files name a plugin by its file name alone, so they follow only the copy it resolves to.
  async function renamePlugin(origin: FileOrigin, from: string, to: string, namedByFileName: boolean): Promise<void> {
    const orders = await everyPluginOrderFile(instanceRoot);
    await withLocks([...orders, ruleFiles.userlist], async () => {
      const { lines, files } = await plan(orders, origin, from, to);
      const { after } = namedByFileName ? await userlistRenamed(ruleFiles.userlist, from, to) : {};
      const texts = namedByFileName ? [...lines, ...(after === undefined ? [] : [{ file: ruleFiles.userlist, after }])] : [];
      await writtenWhole(files, texts);
    });
  }

  return {
    async originHoldsPlugin(origin, name) {
      const folder = await originFolder(context, origin, 'list');
      return folder !== undefined && (await entriesIn(folder)).some((entry) => !entry.isFolder && sameName(entry.name, name));
    },

    async planRename(symbol, newName, _held, plugins) {
      const { name, origin } = symbol;
      const fileOrigin = fileOriginOfPlugin(origin);
      const namedByFileName = namesPlugin({ name }, symbol, plugins);
      try {
        await plan(await everyPluginOrderFile(instanceRoot), fileOrigin, name, newName);
      } catch (err) {
        return { refused: errorMessage(err) };
      }
      const cannotFollow = namedByFileName
        ? [...(await userlistRenamed(ruleFiles.userlist, name, newName)).cannotFollow, ...await leftInLootsFiles([ruleFiles.masterlist, ruleFiles.prelude], name)]
        : [];
      return {
        changes: NO_FILE_CHANGES,
        cannotFollow,
        commit: () => renamePlugin(fileOrigin, name, newName, namedByFileName).then(() => COMMITTED, (err: unknown) => ({ failed: errorMessage(err) })),
      };
    },
  };
}
