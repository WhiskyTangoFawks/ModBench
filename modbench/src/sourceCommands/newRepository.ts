// commands.md, decompile and commit: a repository holding the mod's plugin source, a build file, and as its assets only the
// files its installation file does not yield with their bytes (ADR-0016).

import { basename, join } from 'node:path';
import type { NewRepository } from '../client';
import type { InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import {
  manifestIn, manifestText, packageOf, sourceModsOf, writeManifestIn, type BuildFile, type Manifest, type ManifestFile,
} from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import { pluginCompanionRule } from '../tables/gamePaths';
import { isPluginAtRoot } from '../tables/pluginFile';
import { gameFilesOf, gameHeld, gameToHand, NONE_HELD, type GameToHand } from './gameFolderFacts';
import { buildManifest, type GameHeld, type HashedModFile } from './manifestBuilder';

type Adapter = Pick<InstanceAdapter,
  'sourceFolder' | 'installationFile' | 'modFolderPath' | 'metadataFilesInModFolder' | 'filesIn' | 'originFileHash' | 'textHash'
  | 'gameRelease' | 'gamePlaces' | 'modOrder' | 'gameFiles' | 'gameFilesTakenBy' | 'sourceRepositories' | 'entryKey' | 'modMetadata'>;

/** The repository a mod's decompile and commit makes. */
export interface MadeRepository {
  readonly repository: NewRepository;
}

function pluginsAndTheirStringsFiles(paths: readonly string[], gameRelease: string): Set<string> {
  const plugins = paths.filter(isPluginAtRoot);
  const rule = pluginCompanionRule(gameRelease);
  return new Set([...plugins, ...paths.filter((path) => plugins.some((plugin) => rule?.isStringsFileOf(plugin, path) === true))]);
}

// Each file of the mod's folder but the mod manager's, with its bytes.
async function hashed(
  adapter: Pick<Adapter, 'metadataFilesInModFolder' | 'filesIn' | 'originFileHash'>, folder: string,
): Promise<HashedModFile[] | { readonly refusal: string }> {
  const leftOut = new Set(adapter.metadataFilesInModFolder.map((path) => path.toLowerCase()));
  const files: HashedModFile[] = [];
  for (const path of (await adapter.filesIn(folder)).filter((one) => !leftOut.has(one.toLowerCase()))) {
    const read = await adapter.originFileHash(join(folder, path));
    if (read.kind === 'unreadable') return { refusal: `a file of its folder could not be read: ${read.reason}` };
    files.push({ path, hash: read.answer.hash });
  }
  return files;
}

async function heldManifest(folder: string): Promise<Manifest | undefined | { readonly refusal: string }> {
  try {
    const read = await manifestIn(folder);
    return read === undefined ? undefined : 'refused' in read ? { refusal: `its manifest cannot be read: ${read.refused}` } : read.manifest;
  } catch (err) {
    return { refusal: `its manifest could not be read: ${errorMessage(err)}` };
  }
}

const isTaken = (manifest: Manifest, line: ManifestFile): boolean =>
  (line.entry.kind === 'held' || line.entry.kind === 'heldAt') && packageOf(manifest, line) !== undefined;

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

/** The repository decompile and commit makes for `mod`, as decompile and repair does for a mod with none: its build file,
 *  which takes from the mod's packages each file they give, and its assets. */
export async function newRepositoryOf(adapter: Adapter, mod: string, game: GameToHand): Promise<MadeRepository | { readonly refusal: string }> {
  const read = await modRead(adapter, mod, game);
  if ('refusal' in read) return read;
  const { sourceFolder, folder, installationFile, held } = read;
  const all = await hashed(adapter, folder);
  if ('refusal' in all) return all;
  const compiled = pluginsAndTheirStringsFiles(all.map(({ path }) => path), await adapter.gameRelease());
  const { manifest: recorded } = await buildManifest(
    { downloadedFiles: [], ...installationFile === undefined ? {} : { installationFile }, ...read.game === undefined ? {} : { game: read.game } },
    all.filter(({ path }) => !compiled.has(path)), undefined, held, (text) => adapter.textHash(text));
  const kept = recorded.files.filter((line) => isTaken(recorded, line));
  const notAssets = new Set([...kept.map(({ path }) => path), ...compiled]);
  const buildFile: BuildFile = { packages: recorded.packages, exclude: [], archives: recorded.archives, steps: [], tools: [], files: kept };
  return { repository: { sourceFolder, assets: all.filter(({ path }) => !notAssets.has(path)).map(({ path }) => path), buildFile: manifestText(buildFile) } };
}

type LinkAdapter = Pick<Adapter, 'modFolderPath' | 'modMetadata' | 'metadataFilesInModFolder' | 'filesIn' | 'originFileHash'>;

// The mod is a source mod once its folder's manifest names its repository, with the mod's version, and each file with its
// bytes, so a first build that makes them again destroys nothing (commands.md, Confirm what destroys).
async function folderLinkedOrWhy(adapter: LinkAdapter, mod: string, { repository }: MadeRepository): Promise<string | undefined> {
  const [folder, metadata] = await Promise.all([adapter.modFolderPath(mod), adapter.modMetadata(mod)]);
  if (folder === undefined) return 'its name gives it no folder for a manifest that names its repository';
  try {
    const files = await hashed(adapter, folder);
    if ('refusal' in files) return `its manifest could not name its repository: ${files.refusal}`;
    await writeManifestIn(folder, {
      packages: [{ kind: 'sourceRepository', name: basename(repository.sourceFolder), isSubmodule: false }],
      exclude: [], archives: [], files: files.map(({ path, hash }) => ({ path, entry: { kind: 'held' }, hash })),
      ...metadata.kind === 'read' && metadata.answer.version !== undefined ? { version: metadata.answer.version } : {},
    });
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
