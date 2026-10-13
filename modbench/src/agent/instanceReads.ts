import type { InstanceValue } from '../instanceLoader/instance';

export class Refusal extends Error {}

export interface Read {
  readonly name: string;
  readonly description: string;
  readonly of: (value: InstanceValue) => unknown;
}

const byLine = (a: { line: number | null }, b: { line: number | null }): number =>
  (a.line ?? Infinity) - (b.line ?? Infinity);

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
    name: 'list_plugins',
    description: 'Every plugin by its line in the plugin order, with its origin, whether it is enabled and whether it wins its file name.',
    of: ({ plugins }) => [...plugins].sort(byLine).map(({ name, origin, line, enabled, winning }) => ({ name, origin, line, enabled, winning })),
  },
  {
    name: 'list_downloads',
    description: 'The downloaded files by file name, each with its status and whether it is excluded.',
    of: ({ downloads }) => {
      if (downloads.kind === 'unresolved') throw new Refusal(downloads.reason);
      return downloads.rows.map(({ name, status, excluded }) => ({ name, status, excluded }));
    },
  },
];
