import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';
import type { ReadModStatus } from '../client';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';

export const statusUnreadable = (failure: ReadFailed): string => `The mods' status could not be read: ${failureReason(failure)}`;

export const LIST_MOD_STATUSES = {
  name: 'list_mod_statuses',
  description: 'Each mod\'s and separator\'s folder, by kind and name as list_mods gives them, against its manifest: whether it has no manifest, and the files whose bytes differ from the manifest\'s, '
    + 'that no line of it names, that its folder lacks, and that its package does not hold. An instance that is no repository has no manifests to compare.',
  of: async (value: InstanceValue, readStatus: ReadModStatus) => {
    if (!value.holdsRepository) throw new Refusal('The instance is not a repository, so no mod has a manifest to compare. Request git init first.');
    const folders = value.modFolders ?? [];
    const answer = await readStatus(folders.map(({ modName }) => modName));
    if (isReadFailed(answer)) throw new Refusal(statusUnreadable(answer));
    const entryOf = new Map(folders.map(({ modName, kind, name }) => [modName, { kind, name }]));
    return answer.map(({ mod, ...status }) => ({ ...(entryOf.get(mod) ?? { kind: 'mod', name: mod }), ...status }));
  },
};
