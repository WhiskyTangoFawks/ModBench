import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { manifestAt, packagesAskedAt, statusFrom, type ModAt, type ModStatus } from '../manifestAdapter/manifestAdapter';

/** A mod's status as a command reads it: the manifest, the instance's values, one call. */
export async function statusNow(adapter: Pick<InstanceAdapter, 'modValue'>, mod: ModAt): Promise<ModStatus> {
  const manifest = await manifestAt(mod.folder);
  return statusFrom(mod, manifest, await adapter.modValue(mod.folder, packagesAskedAt(manifest)));
}
