import { refuse } from '../coreLib/refuse';
import { selectionOutcomeOf, type CommandResult, type SelectionResult } from '../coreLib/commandResult';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { Nexus } from '../nexus/nexus';

export interface UpdateChecked {
  name: string;
  /** Set on a mod whose newest version was written. */
  updateAvailable?: boolean;
}

type NexusAsked = Pick<Nexus, 'newestVersion' | 'loggedIn'>;

async function checkMod(adapter: InstanceAdapter, nexus: NexusAsked, mod: string): Promise<CommandResult<{ updateAvailable: boolean }>> {
  try {
    const where = await adapter.nexusFile(mod);
    if (where.kind === 'unreadable') return { applied: false, refusal: where.reason };
    if (where.answer === undefined) return { applied: false, refusal: 'it has no Nexus mod ID' };
    const newest = await nexus.newestVersion(where.answer);
    if (!newest.found) return { applied: false, refusal: newest.reason };
    return { applied: true, ...await adapter.writeNewestVersion(mod, newest.version) };
  } catch (err) {
    return refuse(err);
  }
}

/** `modbench.mod.checkForUpdates` over the mods: each lands on its own (commands.md, A selection is one gesture). */
export const checkForUpdatesOver = (adapter: InstanceAdapter, nexus: NexusAsked) =>
  async (mods: readonly string[]): Promise<SelectionResult<UpdateChecked>> => {
    if (!(await nexus.loggedIn())) return { applied: false, refusal: 'You are not logged in to Nexus.' };
    const toItem = (name: string, landed?: { updateAvailable: boolean }): UpdateChecked =>
      (landed === undefined ? { name } : { name, updateAvailable: landed.updateAvailable });
    return { applied: true, outcome: await selectionOutcomeOf(mods, (mod) => checkMod(adapter, nexus, mod), toItem) };
  };

export type CheckForUpdates = ReturnType<typeof checkForUpdatesOver>;
