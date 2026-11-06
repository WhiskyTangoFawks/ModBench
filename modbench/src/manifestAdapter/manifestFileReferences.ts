import { errorMessage } from '../ports/errorMessage';
import {
  COMMITTED, NO_FILE_CHANGES, placeIn, sameName, spliced, type HeldTexts, type PluginSymbol, type RenamePlan, type SymbolOwner, type SymbolReading,
} from '../symbolNames/symbolNames';
import type { PluginCompanionRule } from '../tables/gamePaths';
import { readBuildFile } from './buildFileRead';
import { stringsOf, VALUE, type StringAt } from './jsonStrings';
import { buildFileTextIn, isBuildFileOf, manifestAt } from './manifestFiles';

// Where a step's string names a file: in the source folder and the mod folder, in the mod folder, in the source folder,
// or in the archive an unpack step takes it out of.
type FileIn = 'sourceAndMod' | 'mod' | 'source' | 'archive';

// Each kind of step's strings that name a file: a value or a member's name, how deep below the step, and where.
const FILES_IN: Readonly<Record<string, readonly (readonly [isValue: boolean, depth: number, within: FileIn])[]>> = {
  decompile: [[true, 1, 'sourceAndMod']],
  copy: [[true, 1, 'sourceAndMod']],
  compile: [[true, 1, 'mod']],
  pack: [[false, 1, 'mod'], [true, 2, 'mod']],
  unpack: [[false, 1, 'source'], [true, 2, 'archive']],
};

function fileIn([steps, , kind, ...rest]: StringAt['path']): FileIn | undefined {
  if (steps !== 'steps') return undefined;
  const isValue = rest.at(-1) === VALUE;
  const depth = isValue ? rest.length - 1 : rest.length;
  return FILES_IN[String(kind)]?.find(([value, at]) => value === isValue && at === depth)?.[2];
}

const isPluginAtTheRoot = (found: StringAt): boolean =>
  ['sourceAndMod', 'mod', 'archive'].includes(fileIn(found.path) ?? '') && found.path.at(-1) === VALUE && found.path.at(2) !== 'pack' && !found.name.includes('/');

function stepStringsIn(text: string): readonly StringAt[] | { readonly refused: string } {
  const read = readBuildFile(text);
  return 'refused' in read ? read : stringsOf(text);
}

function pluginsIn(text: string): readonly StringAt[] | { readonly refused: string } {
  const strings = stepStringsIn(text);
  return 'refused' in strings ? strings : strings.filter(isPluginAtTheRoot);
}

const NONE: SymbolReading = { references: [], leftOut: [] };

const leftOut = (file: string, why: string): SymbolReading => ({ references: [], leftOut: [`${file}: ${why}`] });

interface FileRename {
  readonly from: string;
  readonly to: string;
}

// A build file's text after a rename, each file of the source folder it reads by a changed name, and each name that
// cannot follow.
interface BuildFileRename {
  readonly text?: string;
  readonly sourceFiles: readonly FileRename[];
  readonly cannotFollow: readonly string[];
}

const cannotRead = (file: string, why: string): BuildFileRename => ({ sourceFiles: [], cannotFollow: [`${file}: ${why}`] });

// A step names the plugin's own file and each file the game names for it.
function buildFileRenamed(file: string, text: string, rule: PluginCompanionRule, name: string, newName: string): BuildFileRename {
  const strings = stepStringsIn(text);
  if ('refused' in strings) return cannotRead(file, strings.refused);
  const named = strings.flatMap((found) => {
    const within = fileIn(found.path);
    const renamed = within === undefined ? undefined : rule.renamedWith(name, found.name, newName);
    return within === undefined || renamed === undefined ? [] : [{ ...found, within, renamed }];
  });
  const carried = named.filter(({ within }) => within !== 'archive');
  const renamedAt = new Map(carried.map(({ start, renamed }) => [start, JSON.stringify(renamed).slice(1, -1)]));
  return {
    text: carried.length === 0 ? undefined : spliced(text, carried, (start) => renamedAt.get(start) ?? ''),
    sourceFiles: [...new Map(named.filter(({ within }) => within === 'sourceAndMod' || within === 'source')
      .map(({ name: from, renamed: to }) => [from.toLowerCase(), { from, to }])).values()],
    cannotFollow: named.filter(({ within }) => within === 'archive')
      .map(({ name: spelled, path }) => `${file}: its unpack step takes ${spelled} out of ${String(path[3])} by that name.`),
  };
}

// manifest.md, Who writes it: Modbench writes no manifest's flags.
async function flagsNaming(folder: string, name: string): Promise<string[]> {
  const { read, file } = await manifestAt(folder);
  if (read === undefined) return [];
  if ('refused' in read) return [`${file}: ${read.refused}`];
  return [...read.manifest.flags.keys()].filter((path) => sameName(path, name))
    .map((path) => `${file}: its flags name ${path}, which the user writes.`);
}

export interface ManifestFileOwnerDeps {
  /** Each source mod's source folder, by mod. */
  readonly sourceFolders: () => ReadonlyMap<string, string>;
  /** The folder of a mod, which holds its manifest. */
  readonly modFolderOf: (mod: string) => Promise<string | undefined>;
  /** What the game names for a plugin; undefined for a game the table holds no row for. */
  readonly companions: () => Promise<PluginCompanionRule | undefined>;
}

export type ManifestFileOwner = SymbolOwner & {
  /** Each file of the source folder its build file reads by a name a rename of `symbol` changes, relative to the folder. */
  readonly sourceFilesOf: (symbol: PluginSymbol, newName: string, held: HeldTexts) => Promise<readonly FileRename[]>;
};

/** The manifests and build files as an owner of files that name a plugin: each source mod's build file names the plugins
 *  of that mod, and a mod's manifest names its plugins in its flags. */
export function manifestFileReferences({ sourceFolders, modFolderOf, companions }: ManifestFileOwnerDeps): ManifestFileOwner {
  const folderOf = (origin: string): string | undefined => [...sourceFolders()].find(([named]) => sameName(named, origin))?.[1];
  const buildFileRename = async ({ name, origin }: PluginSymbol, newName: string, held: HeldTexts): Promise<(BuildFileRename & { file?: string }) | undefined> => {
    const [folder, rule] = [folderOf(origin), await companions()];
    if (folder === undefined || rule === undefined) return undefined;
    try {
      const at = await buildFileTextIn(folder, held);
      if (at === undefined) return undefined;
      if ('refused' in at) return cannotRead(at.file, at.refused);
      return { ...buildFileRenamed(at.file, at.text, rule, name, newName), file: at.file };
    } catch (err) {
      return cannotRead(folder, errorMessage(err));
    }
  };
  return {
    nameAt(file, text, offset) {
      const [mod] = [...sourceFolders()].find(([, folder]) => isBuildFileOf(folder, file)) ?? [];
      const plugins = mod === undefined ? [] : pluginsIn(text);
      const named = 'refused' in plugins ? undefined : plugins.find(({ start, end }) => offset >= start && offset <= end);
      return Promise.resolve(named && mod !== undefined ? { name: named.name, origin: mod } : undefined);
    },
    async read({ name, origin }, held) {
      const folder = folderOf(origin);
      if (folder === undefined) return NONE;
      try {
        const at = await buildFileTextIn(folder, held);
        if (at === undefined) return NONE;
        if ('refused' in at) return leftOut(at.file, at.refused);
        const plugins = pluginsIn(at.text);
        if ('refused' in plugins) return leftOut(at.file, plugins.refused);
        const named = plugins.filter((found) => sameName(found.name, name));
        return { references: named.map(({ name: spelled, start, end }) => ({ place: placeIn(at.file, at.text, start, end), names: { name: spelled, origin } })), leftOut: [] };
      } catch (err) {
        return leftOut(folder, errorMessage(err));
      }
    },
    sourceFilesOf: async (symbol, newName, held) => (await buildFileRename(symbol, newName, held))?.sourceFiles ?? [],
    async plan(symbol, newName, held): Promise<RenamePlan> {
      const renamed = await buildFileRename(symbol, newName, held);
      const modFolder = await modFolderOf(symbol.origin);
      const flags = modFolder === undefined ? [] : await flagsNaming(modFolder, symbol.name);
      const { text, file } = renamed ?? {};
      return {
        changes: { ...NO_FILE_CHANGES, documents: text === undefined || file === undefined ? [] : [{ path: file, text }] },
        cannotFollow: [...renamed?.cannotFollow ?? [], ...flags],
        commit: () => Promise.resolve(COMMITTED),
      };
    },
  };
}
