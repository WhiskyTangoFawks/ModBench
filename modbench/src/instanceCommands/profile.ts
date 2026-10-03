// The active-profile gesture (ADR-0015): it hands the Instance adapter the profile to
// select and forgets, and the adapter's signal that the instance changed brings the switch back.

import { refuse } from '../ports/refuse';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

/** What switch profile reaches the instance through. */
export interface ProfileAccess {
  readonly adapter: InstanceAdapter;
}

/** `wrote` is false when the profile was already selected. */
export type ProfileCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

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
