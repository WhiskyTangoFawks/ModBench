// Decompile and repair (plugin-source.md, Decompile and repair): mEdit previews each change, then writes the two
// commits of each plugin it previewed. The Instance adapter names the folder a mod with no repository gets one in.

import { isRefused, type MEditClient, type PluginAddress, type PluginRepairPreview } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { SelectionResult } from '../coreLib/commandResult';

export type DecompileAndRepairClient = Pick<MEditClient, 'repairPreviews' | 'decompileAndRepair'>;

interface DecompileAndRepairAccess {
  readonly adapter: Pick<InstanceAdapter, 'sourceFolder' | 'metadataFilesInModFolder'>;
  readonly client: DecompileAndRepairClient;
}

/** Each change a plugin's preview names, with its record, or the diagnosis no change answers. */
export function previewLines({ plugin, diagnoses }: PluginRepairPreview): string[] {
  return diagnoses.map(({ diagnosis, change }) => `${plugin.name}: ${diagnosis.anchor ?? 'the plugin'}: `
    + (change == null ? `no repair answers ${diagnosis.message}` : change.description));
}

/** `previewed` hears each plugin's preview before anything is written. */
export async function decompileAndRepair(
  { adapter, client }: DecompileAndRepairAccess, plugins: readonly PluginAddress[], force: boolean,
  previewed: (preview: PluginRepairPreview) => void,
): Promise<SelectionResult<PluginAddress>> {
  const previews = await client.repairPreviews(plugins);
  if (isRefused(previews)) return { applied: false, refusal: previews.message };
  previews.landed.forEach(previewed);
  if (previews.landed.length === 0) return { applied: true, outcome: { landed: [], refused: previews.refused } };

  const repaired = await client.decompileAndRepair(
    previews.landed.map(({ plugin, hash }) => ({ plugin, hash, sourceFolder: adapter.sourceFolder(plugin.origin) ?? null })),
    adapter.metadataFilesInModFolder, force);
  if (isRefused(repaired)) return { applied: false, refusal: repaired.message };
  return { applied: true, outcome: { landed: repaired.landed, refused: [...previews.refused, ...repaired.refused] } };
}
