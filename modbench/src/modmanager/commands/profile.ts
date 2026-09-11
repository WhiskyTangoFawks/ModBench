// The active-profile gesture (ADR-0015 invariant 2): a free function returning applied or a
// refusal. It writes ModOrganizer.ini and forgets — the Instance's watcher over that file is
// how the switch comes back.

import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { profileDir, profilesDir, settingsFile } from '../mo2/layout';
import { readSelectedProfile, setSelectedProfileInText } from '../mo2/modOrganizerIni';
import { createWriteQueue } from './writeQueue';

/** `wrote` is false when the profile was already selected: no byte changes, so the
 *  ModOrganizer.ini watcher never fires. */
export type ProfileCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

// Serialized per instance root: two switches read-modify-writing at once would each splice a
// stale generation of the file.
const withIniWriteLock = createWriteQueue();

/** Refuses a profile with no `profiles/<name>/` directory: selecting one points the whole
 *  instance at files that do not exist, which no later read can tell from a corrupt ini. */
export function switchProfile(instanceRoot: string, profile: string): Promise<ProfileCommandResult> {
  return withIniWriteLock(instanceRoot, async (): Promise<ProfileCommandResult> => {
    try {
      await access(profileDir(instanceRoot, profile));
    } catch {
      return { applied: false, refusal: `No such profile: ${profile}` };
    }
    try {
      const before = await readFile(settingsFile(instanceRoot), 'utf8');
      if (readSelectedProfile(before) === profile) return { applied: true, wrote: false };
      await writeFile(settingsFile(instanceRoot), setSelectedProfileInText(before, profile));
      return { applied: true, wrote: true };
    } catch (err) {
      return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** The profiles the switch can choose between — directories under `profiles/`, so a stray file
 *  MO2 left there is never offered as one. The Instance names only the active profile, and the
 *  QuickPick that feeds this command needs the rest. */
export async function listProfiles(instanceRoot: string): Promise<string[]> {
  const dirents = await readdir(profilesDir(instanceRoot), { withFileTypes: true });
  return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
}
