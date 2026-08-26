import type { PluginMetadata } from './ApiClient';

// #347: extracted from pickTargetPlugin (extension.ts) so the two copy gestures' differing
// exclusion rules live in one place, named, instead of one shared predicate silently carrying
// both. The bug this fixes: both callers used to pass the source plugin as a bare exclusion
// string, so "exclude the source" applied to copy-as-new too, ruling out the most ordinary way to
// author a record — copying one as a template within its own plugin.
//
// #494 / xEdit parity (xeMainForm.pas:3023-3042, CopyInto's own module filter): 'copy-as-override'
// excludes every plugin that already carries the record, not merely the source — a plugin two
// levels down the load order can already hold its own override of the same FormKey, and offering
// it as a destination would silently replace that override's own content rather than create one.
// 'copy-as-new' allocates a fresh FormID in the target plugin's own sequence — source and copy
// coexist, and nothing about who else overrides the source record is relevant — so this list is
// ignored entirely for that gesture, unchanged from #347. Immutable (base-game) plugins are never
// a write target, for either gesture.
export type CopyGesture = 'copy-as-new' | 'copy-as-override';

export function copyTargetPlugins(
  allPlugins: PluginMetadata[], gesture: CopyGesture, pluginsCarryingRecord: readonly string[],
): PluginMetadata[] {
  const carrying = new Set(pluginsCarryingRecord);
  return allPlugins.filter(p => !p.isImmutable && (gesture !== 'copy-as-override' || !carrying.has(p.name)));
}
