import type { InstanceValue } from '../instanceLoader/instance';
import type { ModStatuses } from '../modStatus/modStatuses';
import { Refusal } from '../drivingLib/refusal';

const STATUS_MEMBERS = ['noManifest', 'differing', 'namedByNoLine', 'gone', 'notInPackage', 'otherBytes', 'noHost', 'packagesLacking', 'unreadable'] as const;

const isHeld = (member: string | boolean | readonly string[] | undefined): member is string | true | readonly string[] =>
  member === true || (member !== undefined && member !== false && member.length > 0);

export const LIST_MOD_STATUSES = {
  name: 'list_mod_statuses',
  description: 'Mods grouped by status, each mod by name as list_mods gives it, against its manifest: whether it has no manifest (noManifest), and the files whose bytes differ from the manifest\'s (differing), '
    + 'that no line of it names (namedByNoLine), that its folder lacks (gone), that its package does not hold (notInPackage), and that its package holds with other bytes (otherBytes), '
    + 'plus noHost, packagesLacking and unreadable. A member a group lacks is empty. An instance that is no repository has no manifests to compare.',
  of: async (value: InstanceValue, statuses: Pick<ModStatuses, 'current'>) => {
    if (!value.holdsRepository) throw new Refusal('The instance is not a repository, so no mod has a manifest to compare. Request git init first.');
    const derived = await statuses.current();
    const nameOf = new Map((value.modFolders ?? []).filter(({ kind }) => kind === 'mod').map(({ modName, name }) => [modName, name]));
    const groups = new Map<string, { mods: string[] }>();
    for (const read of derived.values()) {
      const name = nameOf.get(read.mod);
      if (name === undefined) continue;
      const present: Record<string, string | boolean | readonly string[]> = {};
      for (const member of STATUS_MEMBERS) {
        const held = read[member];
        if (isHeld(held)) present[member] = held;
      }
      const key = JSON.stringify(present);
      const group = groups.get(key) ?? { mods: [], ...present };
      group.mods.push(name);
      groups.set(key, group);
    }
    return [...groups.values()];
  },
};
