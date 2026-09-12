// The active-profile gesture (ADR-0015 invariant 2): a free function returning applied or a
// refusal. It writes ModOrganizer.ini and forgets — the Instance's watcher over that file is
// how the switch comes back.

import { profileDir, profilesDir, settingsFile } from '../mo2/layout';
import { readSelectedProfile, setSelectedProfileInText } from '../mo2/modOrganizerIni';
import { exists, listDir, putIfChanged } from '../mo2Files';

/** `wrote` is false when the profile was already selected: no byte changes, so the
 *  ModOrganizer.ini watcher never fires. */
export type ProfileCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

/** Refuses a profile with no `profiles/<name>/` directory: selecting one points the whole
 *  instance at files that do not exist, which no later read can tell from a corrupt ini. */
export async function switchProfile(instanceRoot: string, profile: string): Promise<ProfileCommandResult> {
  if (!(await exists(profileDir(instanceRoot, profile)))) {
    return { applied: false, refusal: `No such profile: ${profile}` };
  }
  try {
    const { wrote } = await putIfChanged(
      settingsFile(instanceRoot),
      (before) => (readSelectedProfile(before) === profile ? before : setSelectedProfileInText(before, profile)),
    );
    return { applied: true, wrote };
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
}

/** The profiles the switch can choose between — directories under `profiles/`, so a stray file
 *  MO2 left there is never offered as one. The Instance names only the active profile, and the
 *  QuickPick that feeds this command needs the rest. */
export async function listProfiles(instanceRoot: string): Promise<string[]> {
  const dirents = await listDir(profilesDir(instanceRoot));
  return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
}
