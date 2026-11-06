import { basename, dirname, join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { COMMITTED, heldTextAt, NO_FILE_CHANGES, placeIn, sameName, samePath, spliced, type EntryOwner, type EntryNames, type EntryReading, type EntrySymbol, type FileChanges, type HeldTexts, type RenamePlan } from '../symbolNames/symbolNames';
import { isManifestPath } from '../repositoriesLib/manifestPath';
import { stringsOf, VALUE, type StringAt } from './jsonStrings';
import { manifestNameOf, manifestsIn, textAt, twoManifests } from './manifestFiles';
import { readManifest } from './manifestRead';
import type { Manifest, ManifestPackage } from './manifest';
import { manifestText } from './manifestText';

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

// Each name of a package of `kind` in `text`, where it is spelled.
function packageNamesIn(text: string, kind: 'repository' | 'installationFile'): StringAt[] {
  const strings = stringsOf(text);
  const kindOf = (index: string | number): string | undefined =>
    strings.find(({ path }) => path.length === 4 && path[0] === 'packages' && path[1] === index && path[2] === 'kind' && path[3] === VALUE)?.name;
  return strings.filter(({ path }) =>
    path.length === 4 && path[0] === 'packages' && path[2] === 'name' && path[3] === VALUE && path[1] !== undefined && kindOf(path[1]) === kind);
}

// The text with each repository package named `name` named `newName`.
function withRepositoryRenamed(text: string, name: string, newName: string): string {
  const named = packageNamesIn(text, 'repository').filter(({ name: spelled }) => sameName(spelled, name));
  return spliced(text, named, () => JSON.stringify(newName).slice(1, -1));
}

// The one manifest a mod's folder holds, whatever its name, and its text; or why it cannot be read.
async function manifestTextIn(folder: string, held: HeldTexts): Promise<{ file: string; text: string; manifest: Manifest } | { file: string; refused: string } | undefined> {
  const [one, other] = await manifestsIn(folder);
  if (one === undefined) return undefined;
  const file = join(folder, one);
  if (other !== undefined) return { file, refused: twoManifests(one, other) };
  const text = heldTextAt(held, file) ?? await textAt(file);
  const read = readManifest(text);
  return 'refused' in read ? { file, refused: read.refused } : { file, text, manifest: read.manifest };
}

// Each installation file package of every manifest of `folders`, and why each manifest that could not be read was left out.
async function installationFilesIn(folders: readonly string[], held: HeldTexts) {
  const read = await Promise.all(folders.map(async (folder) => {
    try {
      const at = await manifestTextIn(folder, held);
      if (at === undefined) return { named: [], leftOut: [] };
      if ('refused' in at) return { named: [], leftOut: [`${at.file}: ${at.refused}`] };
      return { named: [{ ...at, packages: packageNamesIn(at.text, 'installationFile') }], leftOut: [] };
    } catch (err) {
      return { named: [], leftOut: [`${folder}: ${errorMessage(err)}`] };
    }
  }));
  return { named: read.flatMap(({ named }) => named), leftOut: read.flatMap(({ leftOut }) => leftOut) };
}

interface ManifestNamesDeps extends Pick<ManifestEntryOwnerDeps, 'modFolderOf'> {
  /** Each listed mod's folder, by the mod's name. */
  readonly modFolders: () => ReadonlyMap<string, string>;
}

const noReferences = { references: [], leftOut: [] };

const unreadable = (where: string, err: unknown): EntryReading => ({ references: [], leftOut: [`${where}: ${errorMessage(err)}`] });

/** The manifests as an owner of the files that name a symbol: a mod's own manifest names the mod at the repository
 *  package of its source folder, and every manifest names a downloaded file at its installation file package. */
export function manifestEntryNames({ modFolderOf, modFolders }: ManifestNamesDeps): EntryNames {
  const ownManifestOf = async (mod: string): Promise<string | undefined> => {
    const folder = await modFolderOf(mod);
    const own = folder === undefined ? undefined : await namedFor(folder, mod);
    return folder === undefined || own === undefined ? undefined : join(folder, own);
  };
  return {
    async listed(kind, held) {
      if (kind !== 'downloadedFile') return [];
      const { named } = await installationFilesIn([...modFolders().values()], held);
      return named.flatMap(({ file, text, packages }) => packages.map(({ name, start, end }) => ({ entry: { kind, name }, place: placeIn(file, text, start, end) })));
    },
    async read({ kind, name: mod }, held) {
      if (kind === 'downloadedFile') {
        const { named, leftOut } = await installationFilesIn([...modFolders().values()], held);
        const references = named.flatMap(({ file, text, packages }) =>
          packages.filter(({ name }) => sameName(name, mod)).map(({ start, end }) => placeIn(file, text, start, end)));
        return { references, leftOut };
      }
      if (kind !== 'mod') return noReferences;
      const owned = await ownManifestOf(mod).then((own) => ({ file: own }), (err: unknown) => ({ err }));
      if ('err' in owned) return unreadable(mod, owned.err);
      const { file } = owned;
      if (file === undefined) return noReferences;
      try {
        const text = heldTextAt(held, file) ?? await textAt(file);
        const read = readManifest(text);
        if ('refused' in read) return { references: [], leftOut: [`${file}: ${read.refused}`] };
        const named = packageNamesIn(text, 'repository').filter(({ name }) => sameName(name, mod));
        return { references: named.map(({ start, end }) => placeIn(file, text, start, end)), leftOut: [] };
      } catch (err) {
        return unreadable(file, err);
      }
    },
    async nameAt(file, text, offset) {
      const holder = [...modFolders()].find(([, folder]) => samePath(folder, dirname(file)));
      const mod = holder?.[0];
      if (mod === undefined || !isManifestPath(basename(file)) || 'refused' in readManifest(text)) return undefined;
      const isAt = ({ start, end }: StringAt): boolean => start <= offset && offset <= end;
      const installed = packageNamesIn(text, 'installationFile').find(isAt);
      if (installed !== undefined) return { entry: { kind: 'downloadedFile', name: installed.name }, start: installed.start, end: installed.end };
      const own = await ownManifestOf(mod).catch(() => undefined);
      const at = own !== undefined && samePath(own, file) ? packageNamesIn(text, 'repository').find((found) => sameName(found.name, mod) && isAt(found)) : undefined;
      return at && { entry: { kind: 'mod', name: mod }, start: at.start, end: at.end };
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

/** The manifests of `modFolders` as an owner of the files that name a downloaded file, in its part of a rename: each
 *  installation file package of its name. */
export function manifestDownloadedFileReferences(modFolders: readonly string[]): EntryOwner {
  return {
    async plan({ kind, name }, newName, held) {
      if (kind !== 'downloadedFile') return changed({});
      const { named, leftOut } = await installationFilesIn(modFolders, held);
      const isRenamed = (pkg: ManifestPackage): boolean => pkg.kind === 'installationFile' && sameName(pkg.name, name);
      const documents = named.flatMap(({ file, manifest }) => {
        if (!manifest.packages.some(isRenamed)) return [];
        const packages = manifest.packages.map((pkg) => (isRenamed(pkg) ? { ...pkg, name: newName } : pkg));
        return [{ path: file, text: manifestText({ ...manifest, packages }) }];
      });
      return changed({ documents }, leftOut);
    },
  };
}
