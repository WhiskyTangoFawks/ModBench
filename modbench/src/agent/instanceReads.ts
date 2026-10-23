import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';

export interface Read {
  readonly name: string;
  readonly description: string;
  readonly of: (value: InstanceValue) => unknown;
}

export const INSTANCE_READS: readonly Read[] = [
  {
    name: 'list_profiles',
    description: 'Every profile of the instance, and the active one.',
    of: ({ profiles, activeProfile }) => ({ active: activeProfile, profiles }),
  },
  {
    name: 'list_mods',
    description: 'The mods and separators in mod order, winning first, each with whether it is enabled.',
    of: ({ mods }) => mods.map(({ kind, name, enabled }) => ({ kind, name, enabled })),
  },
  {
    name: 'list_downloads',
    description: 'The downloaded files by file name, each with its status and whether it is excluded.',
    of: ({ downloadedFiles }) => {
      if (downloadedFiles.kind === 'unresolved') throw new Refusal(downloadedFiles.reason);
      return downloadedFiles.rows.map(({ name, status, excluded }) => ({ name, status, excluded }));
    },
  },
];
