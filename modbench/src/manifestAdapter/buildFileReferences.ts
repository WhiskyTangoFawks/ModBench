import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import {
  NO_FILE_CHANGES, placeIn, sameName, samePath, type FileChanges, type HeldTexts, type RenamePlan, type SymbolOwner, type SymbolReading,
} from '../symbolNames/symbolNames';
import { readBuildFile } from './buildFileRead';
import { buildFileTextIn, isBuildFileName } from './manifestFiles';

interface NameInText {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

type Segment = string | number;

interface StringAt extends NameInText {
  readonly path: readonly Segment[];
}

const WHITESPACE = /\s/;
const SCALAR_END = /[\s,\]}]/;

// Each string value of `text`, a JSON text the build file's read accepted, with its path and the span of its value.
function stringsOf(text: string): StringAt[] {
  const found: StringAt[] = [];
  let at = 0;
  const skipWhitespace = (): void => { while (WHITESPACE.test(text.charAt(at))) at += 1; };
  const string = (): NameInText => {
    const start = at;
    at += 1;
    while (text.charAt(at) !== '"') at += text.charAt(at) === '\\' ? 2 : 1;
    at += 1;
    const name: unknown = JSON.parse(text.slice(start, at));
    return { name: String(name), start: start + 1, end: at - 1 };
  };
  const items = (close: string, item: (index: number) => void): void => {
    at += 1;
    skipWhitespace();
    for (let index = 0; text.charAt(at) !== close; index += 1) {
      item(index);
      skipWhitespace();
      if (text.charAt(at) === ',') at += 1;
      skipWhitespace();
    }
    at += 1;
  };
  const value = (path: readonly Segment[]): void => {
    skipWhitespace();
    const opening = text.charAt(at);
    if (opening === '"') found.push({ ...string(), path });
    else if (opening === '{') items('}', () => { const key = string().name; skipWhitespace(); at += 1; value([...path, key]); });
    else if (opening === '[') items(']', (index) => { value([...path, index]); });
    else while (at < text.length && !SCALAR_END.test(text.charAt(at))) at += 1;
  };
  value([]);
  return found;
}

// The paths of the steps that name a file of the source folder, or one an archive holds: a plugin, at the root.
const isNamingAFile = ([steps, , kind, ...rest]: readonly Segment[]): boolean =>
  steps === 'steps' && (kind === 'unpack' ? rest.length === 2 : ['decompile', 'compile', 'copy'].includes(String(kind)) && rest.length === 1);

const isPluginAtTheRoot = ({ name, path }: StringAt): boolean => isNamingAFile(path) && typeof path.at(-1) === 'number' && !name.includes('/');

interface PluginInStep extends NameInText {
  readonly path: readonly Segment[];
}

function pluginsIn(text: string): readonly PluginInStep[] | { readonly refused: string } {
  const read = readBuildFile(text);
  return 'refused' in read ? read : stringsOf(text).filter(isPluginAtTheRoot);
}

const stepOf = ({ path }: PluginInStep): string => String(path[2]);

const NONE: SymbolReading = { references: [], leftOut: [] };

const leftOut = (file: string, why: string): SymbolReading => ({ references: [], leftOut: [`${file}: ${why}`] });

const NO_RENAME: RenamePlan = { changes: NO_FILE_CHANGES, cannotFollow: [], commit: () => Promise.resolve() };

const cannotFollow = (file: string, why: string): RenamePlan => ({ ...NO_RENAME, cannotFollow: [`${file}: ${why}`] });

function renamedIn(text: string, names: readonly PluginInStep[], newName: string): string {
  const spelled = JSON.stringify(newName).slice(1, -1);
  return [...names].reverse().reduce((renamed, { start, end }) => renamed.slice(0, start) + spelled + renamed.slice(end), text);
}

// A decompile or copy step reads the plugin's file from the source folder, so the file takes the new name too.
async function fileMoveIn(folder: string, name: string, newName: string): Promise<FileChanges['moves'] | { readonly refused: string }> {
  const names = await readdir(folder);
  const held = names.find((entry) => sameName(entry, name));
  if (held === undefined) return [];
  const taken = names.find((entry) => sameName(entry, newName) && entry !== held);
  if (taken !== undefined) return { refused: `${join(folder, taken)} is in the way of ${join(folder, held)}.` };
  return [{ from: join(folder, held), to: join(folder, newName) }];
}

async function renamePlan(folder: string, name: string, newName: string, held: HeldTexts): Promise<RenamePlan | { readonly refused: string }> {
  const at = await buildFileTextIn(folder, held);
  if (at === undefined) return NO_RENAME;
  if ('refused' in at) return cannotFollow(at.file, at.refused);
  const plugins = pluginsIn(at.text);
  if ('refused' in plugins) return cannotFollow(at.file, plugins.refused);
  const named = plugins.filter((found) => sameName(found.name, name));
  const unpacked = named.filter((found) => stepOf(found) === 'unpack');
  const carried = named.filter((found) => stepOf(found) !== 'unpack');
  const moves = carried.some((found) => stepOf(found) !== 'compile') ? await fileMoveIn(folder, name, newName) : [];
  if ('refused' in moves) return moves;
  const text = renamedIn(at.text, carried, newName);
  return {
    changes: { moves, deletions: [], documents: text === at.text ? [] : [{ path: at.file, text }] },
    cannotFollow: unpacked.map(({ name: spelled, path }) => `${at.file}: its unpack step takes ${spelled} out of ${String(path[3])} by that name.`),
    commit: () => Promise.resolve(),
  };
}

/** The build files as an owner of files that name a plugin: each source mod's names the plugins of that mod.
 *  `sourceFolders`: each source mod's source folder, by mod. */
export function buildFileReferences(sourceFolders: () => ReadonlyMap<string, string>): SymbolOwner {
  return {
    nameAt(file, text, offset) {
      const [mod] = [...sourceFolders()].find(([, folder]) => samePath(dirname(file), folder) && isBuildFileName(basename(file))) ?? [];
      const plugins = mod === undefined ? [] : pluginsIn(text);
      const named = 'refused' in plugins ? undefined : plugins.find(({ start, end }) => offset >= start && offset <= end);
      return Promise.resolve(named && mod !== undefined ? { name: named.name, origin: mod } : undefined);
    },
    async read({ name, origin }, held) {
      const [mod, folder] = [...sourceFolders()].find(([named]) => sameName(named, origin)) ?? [];
      if (mod === undefined || folder === undefined) return NONE;
      try {
        const at = await buildFileTextIn(folder, held);
        if (at === undefined) return NONE;
        if ('refused' in at) return leftOut(at.file, at.refused);
        const plugins = pluginsIn(at.text);
        if ('refused' in plugins) return leftOut(at.file, plugins.refused);
        const named = plugins.filter((found) => sameName(found.name, name));
        return { references: named.map(({ name: spelled, start, end }) => ({ place: placeIn(at.file, at.text, start, end), names: { name: spelled, origin: mod } })), leftOut: [] };
      } catch (err) {
        return leftOut(folder, errorMessage(err));
      }
    },
    async plan({ name, origin }, newName, held) {
      const [, folder] = [...sourceFolders()].find(([named]) => sameName(named, origin)) ?? [];
      if (folder === undefined) return NO_RENAME;
      try {
        return await renamePlan(folder, name, newName, held);
      } catch (err) {
        return cannotFollow(folder, errorMessage(err));
      }
    },
  };
}
