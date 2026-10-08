// The switch profile gesture (ADR-0015).

import { refuse } from '../ports/refuse';
import type { CommandResult } from '../coreLib/commandResult';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

/** What switch profile reaches the instance through. */
export interface ProfileAccess {
  readonly adapter: InstanceAdapter;
}

export type ProfileCommandResult = CommandResult;

/** Refuses a name the value's `profiles` does not hold: selecting a profile whose directory is
 *  not there points the whole instance at files that do not exist, which no later read can tell
 *  from a corrupt ini. */
export async function switchProfile(
  access: ProfileAccess, profile: string, profiles: readonly string[],
): Promise<ProfileCommandResult> {
  if (!profiles.includes(profile)) {
    return { applied: false, refusal: `No such profile: ${profile}` };
  }
  try {
    const { wrote } = await access.adapter.selectProfile(profile);
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}
