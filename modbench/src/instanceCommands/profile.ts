// The active-profile gesture (ADR-0015 invariant 2): a free function returning applied or a
// refusal. It writes ModOrganizer.ini and forgets — the Instance's watcher over that file is
// how the switch comes back.

import { settingsFile } from '../instanceAdapter/layout';
import { readSelectedProfile, setSelectedProfileInText } from '../mo2Codecs/modOrganizerIni';
import { putIfChanged } from '../instanceAdapter/files';
import { refuse } from '../ports/refuse';

/** `wrote` is false when the profile was already selected: no byte changes, so the
 *  ModOrganizer.ini watcher never fires. */
export type ProfileCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

/** Refuses a name the value's `profiles` does not hold: selecting a profile whose directory is
 *  not there points the whole instance at files that do not exist, which no later read can tell
 *  from a corrupt ini. */
export async function switchProfile(
  instanceRoot: string, profile: string, profiles: readonly string[],
): Promise<ProfileCommandResult> {
  if (!profiles.includes(profile)) {
    return { applied: false, refusal: `No such profile: ${profile}` };
  }
  try {
    const { wrote } = await putIfChanged(
      settingsFile(instanceRoot),
      (before) => (readSelectedProfile(before) === profile ? before : setSelectedProfileInText(before, profile)),
    );
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}
