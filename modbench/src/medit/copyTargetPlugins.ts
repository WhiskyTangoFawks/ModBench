import type { PluginMetadata } from './ApiClient';

// #347: extracted from pickTargetPlugin (extension.ts) so the two copy gestures' differing
// exclusion rules live in one place, named, instead of one shared predicate silently carrying
// both. The bug this fixes: both callers used to pass the source plugin as a bare exclusion
// string, so "exclude the source" applied to copy-as-new too, ruling out the most ordinary way to
// author a record — copying one as a template within its own plugin.
//
// A plugin cannot override itself, so 'copy-as-override' excludes the source plugin.
// 'copy-as-new' allocates a fresh FormID in the target plugin's own sequence — source and copy
// coexist — so the source plugin stays a legal destination. Immutable (base-game) plugins are
// never a write target, for either gesture.
export type CopyGesture = 'copy-as-new' | 'copy-as-override';

export function copyTargetPlugins(
  allPlugins: PluginMetadata[], sourcePlugin: string, gesture: CopyGesture,
): PluginMetadata[] {
  const excludeSource = gesture === 'copy-as-override';
  return allPlugins.filter(p => !p.isImmutable && (!excludeSource || p.name !== sourcePlugin));
}
