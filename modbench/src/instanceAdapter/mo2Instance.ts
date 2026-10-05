// MO2's implementation of the Instance adapter: its reads, its changes and how it lands a mod,
// over one instance root.

import { existsSync } from 'node:fs';
import { MODLIST_FILE_NAME } from './codecs/modlistText';
import { DOWNLOAD_SIDECAR_SUFFIX } from './codecs/downloads';
import { downloadsDirectoryResolver } from './downloadsDirectory';
import { gameDirectoryResolver, type GameDetectors } from './gameDirectory';
import type { GameDirectoryOverrides, InstanceAdapter } from './instanceAdapter';
import { mo2Changes } from './mo2Changes';
import { mo2ModOrder } from './mo2ModOrder';
import { mo2OriginFiles } from './mo2OriginFiles';
import type { Mo2Context } from './mo2Context';
import { mo2Landing } from './mo2Landing';
import { mo2Reads } from './mo2Reads';
import { mo2Watch } from './mo2Watch';
import { modsDir, profilesDir, settingsFile } from './layout';

export interface Mo2InstanceOptions {
  instanceRoot: string;
  gameDirectoryOverrides: () => GameDirectoryOverrides;
  /** Steam and Wine detection; the real ones when omitted. */
  detectors?: GameDetectors;
}

/** Structural presence only, never file contents: an instance with a corrupt `modlist.txt` still
 *  reads `true` here (common.md, States, story 4). Synchronous: the composition
 *  root asks before an Instance exists. */
export function isMo2Instance(root: string): boolean {
  return existsSync(settingsFile(root)) && existsSync(modsDir(root)) && existsSync(profilesDir(root));
}

export function mo2InstanceAdapter({
  instanceRoot, gameDirectoryOverrides, detectors,
}: Mo2InstanceOptions): InstanceAdapter {
  const context: Mo2Context = {
    instanceRoot,
    resolveGameFolder: gameDirectoryResolver(gameDirectoryOverrides, detectors),
    resolveDownloadsFolder: downloadsDirectoryResolver(detectors),
    watch: mo2Watch(instanceRoot),
  };
  return {
    names: { manager: 'MO2', modOrderFile: MODLIST_FILE_NAME, downloadMetadataFile: DOWNLOAD_SIDECAR_SUFFIX },
    ...mo2Reads(context), ...mo2Changes(context), ...mo2ModOrder(context), ...mo2OriginFiles(context), ...mo2Landing(context),
    subscribe: (listener) => context.watch.subscribe(listener),
  };
}
