import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';

export interface Read {
  readonly name: string;
  readonly description: string;
  readonly of: (value: InstanceValue) => unknown;
}

const byLine = (a: { line: number | null }, b: { line: number | null }): number =>
  (a.line ?? Infinity) - (b.line ?? Infinity);

const noLineMissingReason = ({ kind }: InstanceValue['gameFolder'], inData: InstanceValue['dataFolderPlugins']): string =>
  kind === 'notFound' ? 'The game folder was not found.'
    : inData.kind === 'unreadable' ? `The game folder's Data folder could not be listed: ${inData.reason}` : 'The game folder holds no listable plugins.';

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
    description: 'The plugin order, losing first: the plugins the game loads with no line, then each line by its number. Each plugin has its origin, its line (null when it has none), whether it is enabled and whether it wins its file name. noLineMissing gives the reason the plugins the game loads with no line are not listed, when it cannot name them.',
    of: ({ plugins, pluginsLoadedWithNoLine, gameFolder, dataFolderPlugins }) => ({
      plugins: [
        ...(pluginsLoadedWithNoLine ?? []).map(({ name, origin }) => ({ name, origin, line: null, enabled: true, winning: true })),
        ...[...plugins].sort(byLine).map(({ name, origin, line, enabled, winning }) => ({ name, origin, line, enabled, winning })),
      ],
      ...(pluginsLoadedWithNoLine === undefined && { noLineMissing: noLineMissingReason(gameFolder, dataFolderPlugins) }),
    }),
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
