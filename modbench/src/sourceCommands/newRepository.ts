// commands.md, decompile and commit: a repository holding the mod's plugin source, a manifest naming this folder as the
// output, and as its assets only the files its installation file does not yield with their bytes (ADR-0016).

import { basename, join, resolve } from 'node:path';
import type { NewRepository } from '../client';
import type { InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { manifestIn, packageOf, removeManifestIn, sourceManifestFile, type Manifest, type ManifestFile } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import { pluginCompanionRule } from '../tables/gamePaths';
import { isPluginAtRoot } from '../tables/pluginFile';
import { MANIFEST_SUFFIX } from '../wire/sourceMod';
import { gameFilesOf, gameHeld, gameToHand, NONE_HELD, type GameToHand } from './gameFolderFacts';
import { buildManifest, type GameHeld, type HashedModFile } from './manifestBuilder';

type Adapter = Pick<InstanceAdapter,
  'sourceFolder' | 'installationFile' | 'modMetadata' | 'modFolderPath' | 'metadataFilesInModFolder' | 'filesIn' | 'originFileHash' | 'textHash'
  | 'gameRelease' | 'gamePlaces' | 'modOrder' | 'gameFiles' | 'gameFilesTakenBy' | 'sourceMods'>;

/** The repository a mod's decompile and commit makes, and the mod's folder. */
export interface MadeRepository {
  readonly repository: NewRepository;
  readonly folder: string;
}

const metadataUnreadable = (reason: string): string => `its metadata could not be read: ${reason}`;

function pluginsAndTheirStringsFiles(paths: readonly string[], gameRelease: string): Set<string> {
  const plugins = paths.filter(isPluginAtRoot);
  const rule = pluginCompanionRule(gameRelease);
  return new Set([...plugins, ...paths.filter((path) => plugins.some((plugin) => rule?.isStringsFileOf(plugin, path) === true))]);
}

async function hashed(adapter: Adapter, folder: string, paths: readonly string[]): Promise<HashedModFile[] | { readonly refusal: string }> {
  const files: HashedModFile[] = [];
  for (const path of paths) {
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

// The package a line takes its file from, named, as the repository becomes the manifest's first.
const takenFrom = (manifest: Manifest, line: ManifestFile): string | undefined => {
  if (line.entry.kind !== 'held' && line.entry.kind !== 'heldAt') return undefined;
  return packageOf(manifest, line)?.name;
};

interface ModRead {
  readonly sourceFolder: string;
  readonly folder: string;
  readonly installationFile: InstallationFile | undefined;
  readonly version: string | undefined;
  readonly game: GameHeld | undefined;
  readonly held: Manifest | undefined;
}

// plugins.md, Decompile and commit, story 5: a mod whose files cannot be read whole is refused, naming why.
async function modRead(adapter: Adapter, mod: string, game: GameToHand): Promise<ModRead | { readonly refusal: string }> {
  const sourceFolder = adapter.sourceFolder(mod);
  if (sourceFolder === undefined) return { refusal: 'its name gives it no source folder' };
  const installation = await adapter.installationFile(mod);
  const metadata = await adapter.modMetadata(mod);
  const folder = await adapter.modFolderPath(mod);
  if (installation.kind === 'unreadable') return { refusal: installation.reason };
  if (metadata.kind === 'unreadable') return { refusal: metadataUnreadable(metadata.reason) };
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const taken = typeof game.folder === 'string' ? { gameFiles: NONE_HELD, notes: [] } : await gameFilesOf(adapter, { mod, folder }, game, false);
  if ('refusal' in taken) return taken;
  if (taken.notes.length > 0) return { refusal: taken.notes.join('; ') };
  const held = await heldManifest(folder);
  if (held !== undefined && 'refusal' in held) return held;
  if (typeof game.folder === 'string' && held?.packages.some(({ kind }) => kind === 'gameFolder')) {
    return { refusal: 'its manifest names the game folder, and the game folder was not found' };
  }
  return { sourceFolder, folder, installationFile: installation.answer, version: metadata.answer.version, game: gameHeld(game.folder, taken.gameFiles), held };
}

/** The repository decompile and commit makes for `mod`, as decompile and repair does for a mod with none: its manifest in the
 *  form a build writes, and its assets. */
export async function newRepositoryOf(adapter: Adapter, mod: string, game: GameToHand): Promise<MadeRepository | { readonly refusal: string }> {
  const read = await modRead(adapter, mod, game);
  if ('refusal' in read) return read;
  const { sourceFolder, folder, installationFile, version, held } = read;
  const leftOut = new Set([...adapter.metadataFilesInModFolder, `${basename(folder)}${MANIFEST_SUFFIX}`].map((path) => path.toLowerCase()));
  const all = await hashed(adapter, folder, (await adapter.filesIn(folder)).filter((path) => !leftOut.has(path.toLowerCase())));
  if ('refusal' in all) return all;
  const compiled = pluginsAndTheirStringsFiles(all.map(({ path }) => path), await adapter.gameRelease());
  const { manifest: recorded } = await buildManifest(
    { downloadedFiles: [], ...installationFile === undefined ? {} : { installationFile }, ...read.game === undefined ? {} : { game: read.game } },
    all.filter(({ path }) => !compiled.has(path)), version, held, (text) => adapter.textHash(text));
  const kept = recorded.files.flatMap((line): ManifestFile[] => {
    if (line.entry.kind === 'madeByStep') return [line];
    const pkg = takenFrom(recorded, line);
    return pkg === undefined ? [] : [{ ...line, package: pkg }];
  });
  const notMade = new Set(kept.map(({ path }) => path));
  const made = all.filter(({ path }) => !notMade.has(path));
  const manifest: Manifest = {
    exclude: recorded.exclude, archives: recorded.archives, steps: recorded.steps, tools: recorded.tools,
    packages: [{ kind: 'sourceRepository', name: basename(sourceFolder), isSubmodule: false }, ...recorded.packages],
    files: [...made.map(({ path }): ManifestFile => ({ path, entry: { kind: 'held' } })), ...kept],
    output: basename(folder),
    ...version === undefined ? {} : { version },
  };
  const { name, text } = sourceManifestFile(manifest);
  return { folder, repository: { sourceFolder, assets: made.filter(({ path }) => !compiled.has(path)).map(({ path }) => path), manifestName: name, manifest: text } };
}

/** Why the manifest a mod's folder held could not be removed once its repository holds one (modlist-repository.md, The
 *  manifest, story 1); a repository in the mod's folder keeps its own. */
export async function folderManifestRemovedOrWhy({ folder, repository }: MadeRepository): Promise<string | undefined> {
  if (resolve(folder) === resolve(repository.sourceFolder)) return undefined;
  try {
    await removeManifestIn(folder);
    return undefined;
  } catch (err) {
    return `the manifest in its folder could not be removed: ${errorMessage(err)}`;
  }
}

/** The repository decompile and commit makes for each mod decompile and repair asks for, read as the instance is now. */
export const newRepositoriesOver = (adapter: Adapter): {
  readonly of: (mod: string) => Promise<MadeRepository | { readonly refusal: string }>;
  readonly folderManifestRemovedOrWhy: typeof folderManifestRemovedOrWhy;
} => ({
  of: async (mod) => newRepositoryOf(adapter, mod, await gameToHand(adapter, await adapter.sourceMods())),
  folderManifestRemovedOrWhy,
});
