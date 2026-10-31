// commands.md, decompile and commit: a repository holding the mod's plugin source, a build file, and as its assets only the
// files its installation file does not yield with their bytes (ADR-0016).

import { basename, join } from 'node:path';
import type { NewRepository } from '../client';
import type { InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import {
  buildFileText, manifestIn, ownFilesOf, pinText, sourceModsOf, writeManifestIn, type BuildFile, type BuildFileLine, type BuildFilePackage, type Manifest,
} from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import { pluginCompanionRule } from '../tables/gamePaths';
import { isPluginAtRoot } from '../tables/pluginFile';
import { gameFilesOf, gameHeld, gameToHand, NONE_HELD, type GameToHand } from './gameFolderFacts';
import { buildManifest, downloadedFileOf, nexusFileOf, type GameHeld, type HashedModFile, type Recorded } from './manifestBuilder';

type Adapter = Pick<InstanceAdapter,
  'sourceFolder' | 'installationFile' | 'modFolderPath' | 'metadataFilesInModFolder' | 'filesIn' | 'originFileHash' | 'textHash' | 'nexusFileAt'
  | 'gameRelease' | 'gamePlaces' | 'modOrder' | 'gameFiles' | 'gameFilesTakenBy' | 'sourceRepositories' | 'entryKey' | 'folderValue'>;

/** The repository a mod's decompile and commit makes. */
export interface MadeRepository {
  readonly repository: NewRepository;
}

function pluginsAndTheirStringsFiles(paths: readonly string[], gameRelease: string): Set<string> {
  const plugins = paths.filter(isPluginAtRoot);
  const rule = pluginCompanionRule(gameRelease);
  return new Set([...plugins, ...paths.filter((path) => plugins.some((plugin) => rule?.isStringsFileOf(plugin, path) === true))]);
}

async function hashed(adapter: Pick<Adapter, 'originFileHash'>, folder: string, paths: readonly string[]): Promise<HashedModFile[] | { readonly refusal: string }> {
  const files: HashedModFile[] = [];
  for (const path of paths) {
    const read = await adapter.originFileHash(join(folder, path));
    if (read.kind === 'unreadable') return { refusal: `a file of its folder could not be read: ${read.reason}` };
    files.push({ path, hash: read.answer.hash });
  }
  return files;
}

// A manifest of the format before version 1 names nothing decompile and commit keeps.
async function heldManifest(folder: string): Promise<Manifest | undefined | { readonly refusal: string }> {
  try {
    const read = await manifestIn(folder);
    if (read === undefined || 'olderFormat' in read) return undefined;
    return 'refused' in read ? { refusal: `its manifest cannot be read: ${read.refused}` } : read.manifest;
  } catch (err) {
    return { refusal: `its manifest could not be read: ${errorMessage(err)}` };
  }
}

interface ModRead {
  readonly sourceFolder: string;
  readonly folder: string;
  readonly installationFile: InstallationFile | undefined;
  readonly game: GameHeld | undefined;
  readonly held: Manifest | undefined;
}

// plugins.md, Decompile and commit, story 5: a mod whose files cannot be read whole is refused, naming why.
async function modRead(adapter: Adapter, mod: string, game: GameToHand): Promise<ModRead | { readonly refusal: string }> {
  const sourceFolder = adapter.sourceFolder(mod);
  if (sourceFolder === undefined) return { refusal: 'its name gives it no source folder' };
  const installation = await adapter.installationFile(mod);
  const folder = await adapter.modFolderPath(mod);
  if (installation.kind === 'unreadable') return { refusal: installation.reason };
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const taken = typeof game.folder === 'string' ? { gameFiles: NONE_HELD, notes: [] } : await gameFilesOf(adapter, { mod, folder }, game, false);
  if ('refusal' in taken) return taken;
  if (taken.notes.length > 0) return { refusal: taken.notes.join('; ') };
  const held = await heldManifest(folder);
  if (held !== undefined && 'refusal' in held) return held;
  if (typeof game.folder === 'string' && held?.packages.some(({ kind }) => kind === 'gameFolder')) {
    return { refusal: 'its manifest names the game folder, and the game folder was not found' };
  }
  return { sourceFolder, folder, installationFile: installation.answer, game: gameHeld(game.folder, taken.gameFiles), held };
}

// The build file takes each file a package gives from where the package holds it: an installation file by its name, the
// game folder by the game's release, pinned by the hash of the files it gives.
async function buildFileOf(adapter: Adapter, { manifest, sources }: Recorded, installationFiles: readonly InstallationFile[]): Promise<BuildFile> {
  const gameRelease = await adapter.gameRelease();
  const fromTheGame = [...sources].flatMap(([path, { installationFile, hash }]) => (installationFile === undefined ? [{ path, hash }] : []));
  const packages: BuildFilePackage[] = manifest.packages.flatMap((pkg): BuildFilePackage[] => {
    if (pkg.kind === 'installationFile') {
      const page = installationFiles.find((file) => basename(file.path) === pkg.name)?.page;
      return [{ kind: 'installationFile', name: pkg.name, size: pkg.size, hash: pkg.hash, ...page === undefined ? {} : { page } }];
    }
    return [];
  });
  if (fromTheGame.length > 0) {
    const depots = Object.entries(manifest.packages.find((pkg) => pkg.kind === 'gameFolder')?.host?.steam.depots ?? {}).map(([id, version]) => ({ id, version }));
    packages.push({ kind: 'gameFolder', name: gameRelease, hash: await adapter.textHash(pinText(fromTheGame)), depots });
  }
  const files = [...sources].map(([path, { installationFile, packagePath }]): BuildFileLine => ({
    path, entry: path.toLowerCase() === packagePath.toLowerCase() ? { kind: 'held' } : { kind: 'heldAt', path: packagePath }, package: installationFile ?? gameRelease,
  }));
  return { packages, archives: [], steps: [], tools: [], files };
}

/** The repository decompile and commit makes for `mod`, as decompile and repair does for a mod with none: its build file,
 *  which takes from the mod's packages each file they give, and its assets. */
export async function newRepositoryOf(adapter: Adapter, mod: string, game: GameToHand): Promise<MadeRepository | { readonly refusal: string }> {
  const read = await modRead(adapter, mod, game);
  if ('refusal' in read) return read;
  const { sourceFolder, folder, installationFile, held } = read;
  const all = await hashed(adapter, folder, notMetadata(adapter, await adapter.filesIn(folder)));
  if ('refusal' in all) return all;
  const compiled = pluginsAndTheirStringsFiles(all.map(({ path }) => path), await adapter.gameRelease());
  const own = installationFile === undefined ? undefined : downloadedFileOf(installationFile, nexusFileOf(adapter));
  const recorded = buildManifest(
    { downloadedFiles: [], ...own === undefined ? {} : { installationFile: own }, ...read.game === undefined ? {} : { game: read.game } },
    all.filter(({ path }) => !compiled.has(path)), [], held);
  const notAssets = new Set([...recorded.sources.keys(), ...compiled]);
  const buildFile = await buildFileOf(adapter, recorded, installationFile === undefined ? [] : [installationFile]);
  return { repository: { sourceFolder, assets: all.filter(({ path }) => !notAssets.has(path)).map(({ path }) => path), buildFile: buildFileText(buildFile) } };
}

const notMetadata = (adapter: Pick<Adapter, 'metadataFilesInModFolder'>, paths: readonly string[]): string[] => {
  const leftOut = new Set(adapter.metadataFilesInModFolder.map((path) => path.toLowerCase()));
  return paths.filter((path) => !leftOut.has(path.toLowerCase()));
};

type LinkAdapter = Pick<Adapter, 'modFolderPath' | 'metadataFilesInModFolder' | 'folderValue'>;

// The mod is a source mod once its folder's manifest names its repository. It records the folder as it is, as its build
// would, so a first build that makes the same folder changes nothing.
async function folderLinkedOrWhy(adapter: LinkAdapter, mod: string, { repository }: MadeRepository): Promise<string | undefined> {
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return 'its name gives it no folder for a manifest that names its repository';
  try {
    const value = await adapter.folderValue(folder);
    const leftOut = new Set(adapter.metadataFilesInModFolder.map((path) => path.toLowerCase()));
    const files = ownFilesOf({ files: new Map([...value.files].filter(([pathInFolder]) => !leftOut.has(pathInFolder.toLowerCase()))) });
    if ('why' in files) return files.why;
    await writeManifestIn(folder, { packages: [{ kind: 'repository', name: basename(repository.sourceFolder) }], exclude: value.exclude, files });
    return undefined;
  } catch (err) {
    return `its manifest could not name its repository: ${errorMessage(err)}`;
  }
}

/** Makes each mod of `committed` a source mod of the repository made for it; answers why not, by the mod. */
export async function foldersNotLinked(
  adapter: LinkAdapter, made: ReadonlyMap<string, MadeRepository>, committed: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const notLinked = new Map<string, string>();
  for (const mod of committed) {
    const repository = made.get(mod);
    const why = repository === undefined ? undefined : await folderLinkedOrWhy(adapter, mod, repository);
    if (why !== undefined) notLinked.set(mod, why);
  }
  return notLinked;
}

/** The repository decompile and commit makes for each mod decompile and repair asks for, read as the instance is now. */
export const newRepositoriesOver = (adapter: Adapter): {
  readonly of: (mod: string) => Promise<MadeRepository | { readonly refusal: string }>;
  readonly notLinked: (made: ReadonlyMap<string, MadeRepository>, committed: readonly string[]) => Promise<ReadonlyMap<string, string>>;
} => ({
  of: async (mod) => {
    const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
    return newRepositoryOf(adapter, mod, await gameToHand(adapter, sourceMods));
  },
  notLinked: (made, committed) => foldersNotLinked(adapter, made, committed),
});
