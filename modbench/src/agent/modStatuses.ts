import type { InstanceValue } from '../instanceLoader/instance';
import type { ModStatuses } from '../modStatus/modStatuses';
import { Refusal } from '../drivingLib/refusal';

export const LIST_MOD_STATUSES = {
  name: 'list_mod_statuses',
  description: 'Each mod\'s and separator\'s folder, by kind and name as list_mods gives them, against its manifest: whether it has no manifest, and the files whose bytes differ from the manifest\'s, '
    + 'that no line of it names, that its folder lacks, that its package does not hold, and that its package holds with other bytes. An instance that is no repository has no manifests to compare.',
  of: async (value: InstanceValue, statuses: Pick<ModStatuses, 'current'>) => {
    if (!value.holdsRepository) throw new Refusal('The instance is not a repository, so no mod has a manifest to compare. Request git init first.');
    const derived = await statuses.current();
    const entryOf = new Map((value.modFolders ?? []).map(({ modName, kind, name }) => [modName, { kind, name }]));
    return [...derived.values()].map(({ mod, ...status }) => ({ ...(entryOf.get(mod) ?? { kind: 'mod', name: mod }), ...status }));
  },
};
