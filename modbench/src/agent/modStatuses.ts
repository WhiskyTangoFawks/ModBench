import type { InstanceValue } from '../instanceLoader/instance';
import type { ModStatuses } from '../modStatus/modStatuses';
import { Refusal } from '../drivingLib/refusal';

export const LIST_MOD_STATUSES = {
  name: 'list_mod_statuses',
  description: 'Mods grouped by status, each mod by name as list_mods gives it, against its manifest: whether it has no manifest (noManifest), and the files whose bytes differ from the manifest\'s (differing), '
    + 'that no line of it names (namedByNoLine), that its folder lacks (gone), that its package does not hold (notInPackage), and that its package holds with other bytes (otherBytes), '
    + 'plus noHost, packagesLacking, unreadable, and packages when a mod is not made from one installation file. A member a group lacks is empty. An instance that is no repository has no manifests to compare.',
  of: async (value: InstanceValue, statuses: Pick<ModStatuses, 'current'>) => {
    if (!value.holdsRepository) throw new Refusal('The instance is not a repository, so no mod has a manifest to compare. Request git init first.');
    const derived = await statuses.current();
    const nameOf = new Map((value.modFolders ?? []).filter(({ kind }) => kind === 'mod').map(({ modName, name }) => [modName, name]));
    const groups = new Map<string, { mods: string[] }>();
    for (const { mod, ...status } of derived.values()) {
      const name = nameOf.get(mod);
      if (name === undefined) continue;
      const ordinary = status.packages.length === 1 && status.packages[0]?.kind === 'installationFile';
      const members: Record<string, unknown> = { ...status, packages: ordinary ? [] : status.packages };
      delete members.manifestFile;
      const present = Object.fromEntries(Object.entries(members)
        .filter(([, member]) => member !== false && !(Array.isArray(member) && member.length === 0)));
      const key = JSON.stringify(present);
      const group = groups.get(key) ?? { mods: [], ...present };
      group.mods.push(name);
      groups.set(key, group);
    }
    return [...groups.values()];
  },
};
