import { basename, join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { COMMITTED, heldTextAt, NO_FILE_CHANGES, sameName, spliced, type EntryOwner, type EntrySymbol, type FileChanges, type RenamePlan } from '../symbolNames/symbolNames';
import { stringsOf, VALUE } from './jsonStrings';
import { manifestNameOf, manifestsIn, textAt } from './manifestFiles';
import { readManifest } from './manifestRead';

export interface ManifestEntryOwnerDeps {
  /** The folder of a mod, which holds its manifest. */
  readonly modFolderOf: (mod: string) => Promise<string | undefined>;
  /** The source folder named for a mod, which its rename moves; undefined when it has none. */
  readonly sourceFolderOf: (mod: string) => string | undefined;
}

export type ManifestEntryOwner = EntryOwner & {
  /** Each file of the mod's source folder named for it, relative to the folder, which the folder's move renames. */
  readonly sourceFilesOf: (symbol: EntrySymbol, newName: string) => Promise<readonly { readonly from: string; readonly to: string }[]>;
};

const changed = (changes: Partial<FileChanges>, cannotFollow: readonly string[] = []): RenamePlan =>
  ({ changes: { ...NO_FILE_CHANGES, ...changes }, cannotFollow, commit: () => Promise.resolve(COMMITTED) });

const namedFor = async (folder: string, name: string): Promise<string | undefined> =>
  (await manifestsIn(folder)).find((file) => sameName(file, manifestNameOf(name)));

// The text with each repository package named `name` named `newName`.
function withRepositoryRenamed(text: string, name: string, newName: string): string {
  const strings = stringsOf(text);
  const kindOf = (index: string | number): string | undefined =>
    strings.find(({ path }) => path.length === 4 && path[0] === 'packages' && path[1] === index && path[2] === 'kind' && path[3] === VALUE)?.name;
  const named = strings.filter(({ path, name: spelled }) =>
    path.length === 4 && path[0] === 'packages' && path[2] === 'name' && path[3] === VALUE && path[1] !== undefined && kindOf(path[1]) === 'repository' && sameName(spelled, name));
  return spliced(text, named, () => JSON.stringify(newName).slice(1, -1));
}

/** A mod's manifest as an owner of the files that name a mod: its file is named for the mod, and its repository package
 *  names the source folder named for it, which moves with the rename. */
export function manifestEntryReferences({ modFolderOf, sourceFolderOf }: ManifestEntryOwnerDeps): ManifestEntryOwner {
  return {
    async plan({ kind, name }, newName, held) {
      const folder = kind === 'mod' ? await modFolderOf(name) : undefined;
      if (folder === undefined) return changed({});
      try {
        const own = await namedFor(folder, name);
        if (own === undefined) return changed({});
        const [file, moved] = [join(folder, own), join(folder, manifestNameOf(newName))];
        const moves = own === manifestNameOf(newName) ? [] : [{ from: file, to: moved }];
        const source = sourceFolderOf(name);
        if (source === undefined) return changed({ moves });
        const text = heldTextAt(held, file) ?? await textAt(file);
        const read = readManifest(text);
        if ('refused' in read) return changed({ moves }, [`${file}: ${read.refused}`]);
        const renamed = withRepositoryRenamed(text, basename(source), newName);
        return changed({ moves, documents: renamed === text ? [] : [{ path: moved, text: renamed }] });
      } catch (err) {
        return changed({}, [`${folder}: ${errorMessage(err)}`]);
      }
    },
    async sourceFilesOf({ kind, name }, newName) {
      const source = kind === 'mod' ? sourceFolderOf(name) : undefined;
      const own = source === undefined ? undefined : await namedFor(source, basename(source));
      return own === undefined ? [] : [{ from: own, to: manifestNameOf(newName) }];
    },
  };
}
