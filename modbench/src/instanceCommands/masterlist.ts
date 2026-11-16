import { refuse } from '../coreLib/refuse';
import type { CommandResult } from '../coreLib/commandResult';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { MoveToTrash } from '../ports/trash';
import type { LootMetadata } from '../lootMetadata/lootMetadata';

async function update(adapter: InstanceAdapter, lootMetadata: LootMetadata, trash: MoveToTrash): Promise<CommandResult<{ written: readonly string[] }>> {
  try {
    const fetched = await lootMetadata.fetch(await adapter.gameRelease());
    if (!fetched.found) return { applied: false, refusal: fetched.reason };
    const { written } = await adapter.changeMasterlist({ masterlist: fetched.masterlist, prelude: fetched.prelude }, trash);
    return { applied: true, written };
  } catch (err) {
    return refuse(err);
  }
}

/** Update masterlist, bound to one instance. `update` sends the files it replaces to the trash. */
export function masterlistCommands({ adapter, lootMetadata, trash }: { adapter: InstanceAdapter; lootMetadata: LootMetadata; trash: MoveToTrash }) {
  return {
    update: () => update(adapter, lootMetadata, trash),
  };
}

export type MasterlistCommands = ReturnType<typeof masterlistCommands>;
