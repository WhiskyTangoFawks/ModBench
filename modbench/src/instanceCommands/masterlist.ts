import { refuse } from '../coreLib/refuse';
import type { CommandResult } from '../coreLib/commandResult';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { LootMetadata } from '../lootMetadata/lootMetadata';

async function update(adapter: InstanceAdapter, lootMetadata: LootMetadata): Promise<CommandResult<{ written: readonly string[] }>> {
  try {
    const fetched = await lootMetadata.fetch(await adapter.gameRelease());
    if (!fetched.found) return { applied: false, refusal: fetched.reason };
    const { written } = await adapter.changeMasterlist({ masterlist: fetched.masterlist, prelude: fetched.prelude });
    return { applied: true, written };
  } catch (err) {
    return refuse(err);
  }
}

async function uncommitted(adapter: InstanceAdapter): Promise<CommandResult<{ files: readonly string[] }>> {
  try {
    return { applied: true, files: await adapter.uncommittedMasterlist() };
  } catch (err) {
    return refuse(err);
  }
}

/** Update masterlist, bound to one instance. `update` replaces the files whatever git holds of them: asking first is the caller's. */
export function masterlistCommands({ adapter, lootMetadata }: { adapter: InstanceAdapter; lootMetadata: LootMetadata }) {
  return {
    update: () => update(adapter, lootMetadata),
    uncommitted: () => uncommitted(adapter),
  };
}

export type MasterlistCommands = ReturnType<typeof masterlistCommands>;
