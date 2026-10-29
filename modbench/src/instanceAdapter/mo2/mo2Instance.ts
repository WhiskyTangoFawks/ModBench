// MO2's implementation of the Instance adapter: its reads, its changes and how it lands a mod,
// over one instance root.

import { existsSync } from 'node:fs';
import { downloadsDirectoryResolver } from './downloadsDirectory';
import { steamRootOn } from '../gameFolder/gamePathDetector';
import { nonSteamPrefixRunning } from '../gameFolder/steamPrefix';
import { gameFolderResolver, steamInstallResolver, STEAM } from '../gameFolder/gameFolderResolver';
import { myGamesResolver } from '../gameFolder/myGames';
import type { DeployedPath, GameFolder, InstallationFileReader, GameFolderSetting } from '../instanceAdapter';
import type { FomodEngine } from '../fomodInstaller/fomodInstaller';
import type { ConfigurationFile, ManagerAdapter } from '../publisher';
import { mo2Changes } from './mo2Changes';
import { mo2ModOrder } from './mo2ModOrder';
import { mo2OriginFiles } from './mo2OriginFiles';
import type { Mo2Context } from './mo2Context';
import { mo2Landing } from './mo2Landing';
import { mo2Repository } from './mo2Repository';
import { mo2Submodules } from './mo2Submodules';
import { mo2PathTokens } from './mo2PathTokens';
import { mo2PluginRename } from './mo2PluginRename';
import { mo2Installation } from './mo2Installation';
import { readInstance } from '../instanceReading';
import { mo2Reads, readingSource } from './mo2Reads';
import { mo2Watch } from './mo2Watch';
import { programRunning } from '../processes';
import { hashIndex } from '../downloadedFileContents/hashIndex';
import { hashIndexDir, modlistFile, modsDir, profilesDir, settingsFile, statCacheDir } from './layout';
import { parseModlist } from './codecs/modlistText';
import { get } from '../files';
import { gamePlacesOf } from '../gameFolder/gamePlaces';
import { overlappedGameRoot } from '../gameFolder/pathWithin';

export { overwriteDir } from './layout';

/** The mods `profile`'s mod order enables, by name, read now. */
export const enabledModsIn = (instanceRoot: string) => async (profile: string): Promise<string[]> =>
  parseModlist(await get(modlistFile(instanceRoot, profile))).flatMap((entry) => (entry.kind === 'mod' && entry.enabled ? [entry.name] : []));

const MO2_PROGRAM = 'ModOrganizer.exe';

export type Mo2InstanceOptions = {
  instanceRoot: string;
  installationFileReader: InstallationFileReader;
  fomodEngine: FomodEngine;
  deployedPath: DeployedPath;
} & ({ gameFolderSetting: GameFolderSetting } | { context: Mo2Context });

/** Structural presence only, never file contents: an instance with a corrupt `modlist.txt` still
 *  reads `true` here (common.md, States, story 4). Synchronous: the composition
 *  root asks before an Instance exists. */
export function isMo2Instance(root: string): boolean {
  return existsSync(settingsFile(root)) && existsSync(modsDir(root)) && existsSync(profilesDir(root));
}

export function mo2InstanceAdapter(options: Mo2InstanceOptions, publisherFile: ConfigurationFile | undefined): ManagerAdapter {
  const { instanceRoot, installationFileReader, fomodEngine, deployedPath } = options;
  const context: Mo2Context = 'context' in options ? options.context : {
    instanceRoot,
    resolveGameFolder: gameFolderResolver(options.gameFolderSetting),
    resolveSteamInstall: steamInstallResolver(),
    resolveDownloadsFolder: downloadsDirectoryResolver(),
    resolveMyGames: myGamesResolver(instanceRoot, STEAM),
    watch: mo2Watch(instanceRoot, options.gameFolderSetting.changed),
    mo2Running: () => programRunning(MO2_PROGRAM),
  };
  const hashes = hashIndex(hashIndexDir(instanceRoot), installationFileReader);
  const source = readingSource(context, publisherFile);
  const gameFolder = async (): Promise<GameFolder> => (await source.settings()).gameFolder();
  return {
    names: source.names,
    reading: () => readInstance(source),
    activeProfile: async () => (await source.settings()).profile,
    gameRelease: async () => (await source.settings()).gameRelease,
    gameFolder,
    gameFolderOverlapping: async (folder) => overlappedGameRoot(await gameFolder(), folder),
    nonSteamPrefix: (folder) => nonSteamPrefixRunning(steamRootOn(process.platform), folder),
    gamePlaces: async () => gamePlacesOf(await gameFolder(), await context.resolveSteamInstall((await source.settings()).gameRelease)),
    ...mo2Reads(context, source), ...mo2Installation(context, hashes), ...mo2Changes(context, source), ...mo2ModOrder(context), ...mo2OriginFiles(context), ...mo2PluginRename(context, source), ...mo2Landing(context, installationFileReader, source, fomodEngine), ...mo2Repository(context, hashes, publisherFile, deployedPath), ...mo2Submodules(context), ...mo2PathTokens(context, gameFolder, publisherFile),
    originFileHash: hashes.originFileHash,
    statCacheFolder: statCacheDir(instanceRoot),
    subscribe: (listener) => context.watch.subscribe(listener),
  };
}
