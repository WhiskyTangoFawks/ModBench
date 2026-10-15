import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';
import type { ModStatus } from '../client';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';

export type ReadModStatus = (mods: readonly string[]) => Promise<readonly ModStatus[] | ReadFailed>;

export const LIST_MOD_STATUSES = {
  name: 'list_mod_statuses',
  description: 'Each mod\'s folder against its manifest: whether it has no manifest, and the files whose bytes differ from the manifest\'s, '
    + 'that no line of it names, that its folder lacks, and that have no provider. An instance that is no repository has no manifests to compare.',
  of: async (value: InstanceValue, read: ReadModStatus | undefined) => {
    if (read === undefined) throw new Refusal('There is no Modbench instance open in this window.');
    if (!value.holdsRepository) throw new Refusal('The instance is not a repository, so no mod has a manifest to compare. Request git init first.');
    const answer = await read(value.mods.flatMap(({ kind, name }) => (kind === 'mod' ? [name] : [])));
    if (isReadFailed(answer)) throw new Refusal(`The mods' status could not be read: ${failureReason(answer)}`);
    return answer;
  },
};
