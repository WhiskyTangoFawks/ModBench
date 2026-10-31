import type { InstanceValue } from '../instanceLoader/instance';
import type { ModStatuses } from '../modStatus/modStatuses';
import { Refusal } from '../drivingLib/refusal';

export const LIST_MOD_STATUSES = {
  name: 'list_mod_statuses',
  description: 'Each mod\'s folder, by name as list_mods gives it, against its manifest: whether it has no manifest, and the files whose bytes differ from the manifest\'s, '
    + 'that no line of it names, that its folder lacks, that its package does not hold, and that its package holds with other bytes. An instance that is no repository has no manifests to compare.',
  of: async (value: InstanceValue, statuses: Pick<ModStatuses, 'current'>) => {
    if (!value.holdsRepository) throw new Refusal('The instance is not a repository, so no mod has a manifest to compare. Request git init first.');
    const derived = await statuses.current();
    const nameOf = new Map((value.modFolders ?? []).filter(({ kind }) => kind === 'mod').map(({ modName, name }) => [modName, name]));
    return [...derived.values()].flatMap(({ mod, ...status }) => {
      const name = nameOf.get(mod);
      return name === undefined ? [] : [{ name, ...status }];
    });
  },
};
