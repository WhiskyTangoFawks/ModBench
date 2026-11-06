import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { heldTexts, type PluginSymbol, type RenamePlan, type ResolvedPlugin } from '../symbolNames/symbolNames';

/** The adapter's part of renaming `plugin`, the copy its file name resolves to unless `plugins` says otherwise; rejects
 *  with the refusal. */
export async function renamePlanOf(
  adapter: Pick<InstanceAdapter, 'pluginReferences'>, plugin: PluginSymbol, newName: string, plugins: readonly ResolvedPlugin[] = [{ ...plugin, winning: true }],
): Promise<RenamePlan> {
  const plan = await adapter.pluginReferences.plan(plugin, newName, heldTexts([]), plugins);
  if ('refused' in plan) throw new Error(plan.refused);
  return plan;
}

/** Renames `plugin` through the adapter alone, as its commit writes it; rejects with a refusal or a failed write. */
export async function renamedPlugin(adapter: Pick<InstanceAdapter, 'pluginReferences'>, plugin: PluginSymbol, newName: string): Promise<void> {
  const failed = await (await renamePlanOf(adapter, plugin, newName)).commit();
  if (failed !== undefined) throw new Error(failed);
}
