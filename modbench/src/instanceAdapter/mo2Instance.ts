// MO2's implementation of the Instance adapter: its reads, its changes and how it lands a mod,
// over one instance root.

import { existsSync } from 'node:fs';
import { MODLIST_FILE_NAME } from './codecs/modlistText';
import { DOWNLOAD_SIDECAR_SUFFIX } from './codecs/downloads';
import { downloadsDirectoryResolver } from './downloadsDirectory';
import { gameDirectoryResolver, STEAM, type GameDetectors } from './gameDirectory';
import { myGamesResolver } from './myGames';
import type { ArchiveReader, GameDirectoryOverrides, InstanceAdapter, ManagerNames, Subscription } from './instanceAdapter';
import { mo2Changes } from './mo2Changes';
import { mo2ModOrder } from './mo2ModOrder';
import { mo2OriginFiles } from './mo2OriginFiles';
import type { Mo2Context } from './mo2Context';
import { mo2Landing } from './mo2Landing';
import { mo2Repository } from './mo2Repository';
import { mo2PluginRename } from './mo2PluginRename';
import { mo2Installation } from './mo2Installation';
import { mo2Reads, readingSource, readInstance } from './mo2Reads';
import { mo2Watch } from './mo2Watch';
import { hashIndex } from './hashIndex';
import { hashIndexDir, modsDir, profilesDir, settingsFile, statCacheDir } from './layout';

interface Mo2Machine {
  gameDirectoryOverrides: () => GameDirectoryOverrides;
  /** Hears the setting behind `gameDirectoryOverrides` change. */
  gameDirectoryChanged: (listener: () => void) => Subscription;
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
    resolveGameFolder: gameDirectoryResolver(options.gameDirectoryOverrides, options.detectors),
    resolveDownloadsFolder: downloadsDirectoryResolver(options.detectors),
    resolveMyGames: myGamesResolver(instanceRoot, options.detectors ?? STEAM),
    watch: mo2Watch(instanceRoot, options.gameDirectoryChanged),
  };
  const hashes = hashIndex(hashIndexDir(instanceRoot), archives);
  const names: ManagerNames = { manager: 'MO2', modOrderFile: MODLIST_FILE_NAME, downloadMetadataFile: DOWNLOAD_SIDECAR_SUFFIX };
  const source = readingSource(context);
  return {
    names,
    reading: () => readInstance(source),
    ...mo2Reads(context), ...mo2Installation(context, hashes), ...mo2Changes(context), ...mo2ModOrder(context), ...mo2OriginFiles(context), ...mo2PluginRename(context), ...mo2Landing(context, archives), ...mo2Repository(context, hashes),
    originFileHash: hashes.originFileHash,
    statCacheFolder: statCacheDir(instanceRoot),
    subscribe: (listener) => context.watch.subscribe(listener),
  };
}
