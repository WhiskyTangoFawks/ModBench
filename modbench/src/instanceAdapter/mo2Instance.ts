// MO2's implementation of the Instance adapter: its reads, its changes and how it lands a mod,
// over one instance root.

import { downloadsDirectoryResolver } from './downloadsDirectory';
import { gameDirectoryResolver, type GameDetectors, type GameDirectoryOverrides } from './gameDirectory';
import type { InstanceAdapter } from './instanceAdapter';
import { mo2Changes } from './mo2Changes';
import type { Mo2Context } from './mo2Context';
import { mo2Landing } from './mo2Landing';
import { mo2Reads } from './mo2Reads';
import { mo2Watch, type WatchFiles } from './mo2Watch';

export interface Mo2InstanceOptions {
  instanceRoot: string;
  gameDirectoryOverrides: () => GameDirectoryOverrides;
  /** Steam and Wine detection; the real ones when omitted. */
  detectors?: GameDetectors;
  watchFiles: WatchFiles;
}

export function mo2InstanceAdapter({
  instanceRoot, gameDirectoryOverrides, detectors, watchFiles,
}: Mo2InstanceOptions): InstanceAdapter {
  const context: Mo2Context = {
    instanceRoot,
    resolveGameFolder: gameDirectoryResolver(gameDirectoryOverrides, detectors),
    resolveDownloadsFolder: downloadsDirectoryResolver(detectors),
    watch: mo2Watch(instanceRoot, watchFiles),
  };
  return {
    ...mo2Reads(context), ...mo2Changes(context), ...mo2Landing(context),
    subscribe: (listener) => context.watch.subscribe(listener),
  };
}
