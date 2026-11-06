import { basename, dirname, join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { COMMITTED, heldTextAt, NO_FILE_CHANGES, placeIn, sameName, samePath, spliced, type EntryOwner, type EntryNames, type EntrySymbol, type FileChanges, type RenamePlan } from '../symbolNames/symbolNames';
import { stringsOf, VALUE, type StringAt } from './jsonStrings';
import { manifestNameOf, manifestsIn, textAt } from './manifestFiles';
import { readManifest } from './manifestRead';

export interface ManifestEntryOwnerDeps {
  /** The folder of a mod, which holds its manifest. */
  readonly modFolderOf: (mod: string) => Promise<string | undefined>;
  /** The source folder named for the mod renamed, which the rename moves; undefined when it has none. */
  readonly sourceFolder: string | undefined;
}

export type ManifestEntryOwner = EntryOwner & {
  /** Each file of the mod's source folder named for it, relative to the folder, which the folder's move renames. */
  readonly sourceFilesOf: (symbol: EntrySymbol, newName: string) => Promise<readonly { readonly from: string; readonly to: string }[]>;
};

const changed = (changes: Partial<FileChanges>, cannotFollow: readonly string[] = []): RenamePlan =>
  ({ changes: { ...NO_FILE_CHANGES, ...changes }, cannotFollow, commit: () => Promise.resolve(COMMITTED) });

const namedFor = async (folder: string, name: string): Promise<string | undefined> =>
  (await manifestsIn(folder)).find((file) => sameName(file, manifestNameOf(name)));

// Each repository package's name in `text`, where it is spelled.
function repositoryNamesIn(text: string): StringAt[] {
  const strings = stringsOf(text);
  const kindOf = (index: string | number): string | undefined =>
    strings.find(({ path }) => path.length === 4 && path[0] === 'packages' && path[1] === index && path[2] === 'kind' && path[3] === VALUE)?.name;
  return strings.filter(({ path }) =>
    path.length === 4 && path[0] === 'packages' && path[2] === 'name' && path[3] === VALUE && path[1] !== undefined && kindOf(path[1]) === 'repository');
}

// The text with each repository package named `name` named `newName`.
function withRepositoryRenamed(text: string, name: string, newName: string): string {
  const named = repositoryNamesIn(text).filter(({ name: spelled }) => sameName(spelled, name));
  return spliced(text, named, () => JSON.stringify(newName).slice(1, -1));
}

/** A mod's manifest as an owner of the files that name a mod: its repository package names the source folder named for it. */
export function manifestEntryNames({ modFolderOf }: Pick<ManifestEntryOwnerDeps, 'modFolderOf'>): EntryNames {
  const ownManifestOf = async (mod: string): Promise<string | undefined> => {
    const folder = await modFolderOf(mod);
    const own = folder === undefined ? undefined : await namedFor(folder, mod);
    return folder === undefined || own === undefined ? undefined : join(folder, own);
  };
  return {
    async read({ kind, name: mod }, held) {
      if (kind !== 'mod') return { references: [], leftOut: [] };
      let file: string | undefined;
      try {
        file = await ownManifestOf(mod);
        if (file === undefined) return { references: [], leftOut: [] };
        const text = heldTextAt(held, file) ?? await textAt(file);
        const read = readManifest(text);
        if ('refused' in read) return { references: [], leftOut: [`${file}: ${read.refused}`] };
        const named = repositoryNamesIn(text).filter(({ name }) => sameName(name, mod));
        return { references: named.map(({ start, end }) => placeIn(file ?? '', text, start, end)), leftOut: [] };
      } catch (err) {
        return { references: [], leftOut: [`${file ?? mod}: ${errorMessage(err)}`] };
      }
    },
    async nameAt(file, text, offset) {
      const mod = basename(dirname(file));
      const own = await ownManifestOf(mod).catch(() => undefined);
      if (own === undefined || !samePath(own, file) || 'refused' in readManifest(text)) return undefined;
      const [at] = repositoryNamesIn(text).filter(({ name, start, end }) => sameName(name, mod) && start <= offset && offset <= end);
      return at && { kind: 'mod', name: mod };
    },
  };
}

/** A mod's manifest as an owner of the files that name a mod: its file is named for the mod, and its repository package
 *  names the source folder named for it, which moves with the rename. */
export function manifestEntryReferences({ modFolderOf, sourceFolder }: ManifestEntryOwnerDeps): ManifestEntryOwner {
  return {
    async plan({ kind, name }, newName, held) {
      const folder = kind === 'mod' ? await modFolderOf(name) : undefined;
      if (folder === undefined) return changed({});
      try {
        const own = await namedFor(folder, name);
        if (own === undefined) return changed({});
        const [file, moved] = [join(folder, own), join(folder, manifestNameOf(newName))];
        const moves = own === manifestNameOf(newName) ? [] : [{ from: file, to: moved }];
        if (sourceFolder === undefined) return changed({ moves });
        const text = heldTextAt(held, file) ?? await textAt(file);
        const read = readManifest(text);
        if ('refused' in read) return changed({ moves }, [`${file}: ${read.refused}`]);
        const renamed = withRepositoryRenamed(text, basename(sourceFolder), newName);
        return changed({ moves, documents: renamed === text ? [] : [{ path: moved, text: renamed }] });
      } catch (err) {
        return changed({}, [`${folder}: ${errorMessage(err)}`]);
      }
    },
    async sourceFilesOf({ kind }, newName) {
      const source = kind === 'mod' ? sourceFolder : undefined;
      const own = source === undefined ? undefined : await namedFor(source, basename(source));
      return own === undefined ? [] : [{ from: own, to: manifestNameOf(newName) }];
    },
  };
}
