// The switch profile gesture (ADR-0015).

import { refuse } from '../ports/refuse';
import type { CommandResult } from '../coreLib/commandResult';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

/** Refuses a name the value's `profiles` does not hold: selecting a profile whose directory is
 *  not there points the whole instance at files that do not exist, which no later read can tell
 *  from a corrupt ini. */
export async function switchProfile(
  adapter: InstanceAdapter, profile: string, profiles: readonly string[],
): Promise<CommandResult> {
  if (!profiles.includes(profile)) {
    return { applied: false, refusal: `No such profile: ${profile}` };
  }
  try {
    const { wrote } = await adapter.selectProfile(profile);
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}
