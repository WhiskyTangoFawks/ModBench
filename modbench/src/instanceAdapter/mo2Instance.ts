// MO2's implementation of the Instance adapter: its reads, its changes and how it lands a mod,
// over one instance root.

import { existsSync } from 'node:fs';
import { downloadsDirectoryResolver } from './downloadsDirectory';
import { gameFolderResolver, STEAM, type GameDetectors } from './gameFolder/gameFolderResolver';
import { myGamesResolver } from './gameFolder/myGames';
import type { ArchiveReader, GameFolderSetting, InstanceAdapter } from './instanceAdapter';
import { mo2Changes } from './mo2Changes';
import { mo2ModOrder } from './mo2ModOrder';
import { mo2OriginFiles } from './mo2OriginFiles';
import type { Mo2Context } from './mo2Context';
import { mo2Landing } from './mo2Landing';
import { mo2Repository } from './mo2Repository';
import { mo2Submodules } from './mo2Submodules';
import { mo2PluginRename } from './mo2PluginRename';
import { mo2Installation } from './mo2Installation';
import { readInstance } from './instanceReading';
import { mo2Reads, readingSource } from './mo2Reads';
import { mo2Watch } from './mo2Watch';
import { programRunning } from './processes';
import { hashIndex } from './hashIndex';
import { hashIndexDir, modsDir, profilesDir, settingsFile, statCacheDir } from './layout';

const MO2_PROGRAM = 'ModOrganizer.exe';

interface Mo2Machine {
  gameFolderSetting: GameFolderSetting;
  /** Steam and Wine detection; the real ones when omitted. */
  detectors?: GameDetectors;
}

type Mo2InstanceOptions = {
  instanceRoot: string;
  archives: ArchiveReader;
} & (Mo2Machine | { context: Mo2Context });

/** Structural presence only, never file contents: an instance with a corrupt `modlist.txt` still
 *  reads `true` here (common.md, States, story 4). Synchronous: the composition
 *  root asks before an Instance exists. */
export function isMo2Instance(root: string): boolean {
  return existsSync(settingsFile(root)) && existsSync(modsDir(root)) && existsSync(profilesDir(root));
}

export function mo2InstanceAdapter(options: Mo2InstanceOptions): InstanceAdapter {
  const { instanceRoot, archives } = options;
  const context: Mo2Context = 'context' in options ? options.context : {
    instanceRoot,
    resolveGameFolder: gameFolderResolver(options.gameFolderSetting, options.detectors),
    resolveDownloadsFolder: downloadsDirectoryResolver(options.detectors),
    resolveMyGames: myGamesResolver(instanceRoot, options.detectors ?? STEAM),
    watch: mo2Watch(instanceRoot, options.gameFolderSetting.changed),
    mo2Running: () => programRunning(MO2_PROGRAM),
  };
  const hashes = hashIndex(hashIndexDir(instanceRoot), archives);
  const source = readingSource(context);
  return {
    names: source.names,
    reading: () => readInstance(source),
    activeProfile: async () => (await source.settings()).profile,
    ...mo2Reads(context, source), ...mo2Installation(context, hashes, source), ...mo2Changes(context, source), ...mo2ModOrder(context), ...mo2OriginFiles(context), ...mo2PluginRename(context), ...mo2Landing(context, archives, source), ...mo2Repository(context, hashes), ...mo2Submodules(context),
    originFileHash: hashes.originFileHash,
    statCacheFolder: statCacheDir(instanceRoot),
    subscribe: (listener) => context.watch.subscribe(listener),
  };
}
