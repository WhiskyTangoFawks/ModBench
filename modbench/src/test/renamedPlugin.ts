import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { heldTexts, type PluginSymbol, type RenamePlan } from '../symbolNames/symbolNames';

/** The adapter's part of renaming `plugin`; rejects with the refusal. */
export async function renamePlanOf(adapter: Pick<InstanceAdapter, 'pluginReferences'>, plugin: PluginSymbol, newName: string): Promise<RenamePlan> {
  const plan = await adapter.pluginReferences.plan(plugin, newName, heldTexts([]));
  if ('refused' in plan) throw new Error(plan.refused);
  return plan;
}

/** Renames `plugin` through the adapter alone, as its commit writes it; rejects with a refusal or a failed write. */
export async function renamedPlugin(adapter: Pick<InstanceAdapter, 'pluginReferences'>, plugin: PluginSymbol, newName: string): Promise<void> {
  await (await renamePlanOf(adapter, plugin, newName)).commit();
}
