import type { InstanceValue } from '../instanceLoader/instance';
import { pluginOrderOf } from '../instanceLoader/pluginOrder';
import { Refusal } from '../drivingLib/refusal';

export interface Read {
  readonly name: string;
  readonly description: string;
  readonly of: (value: InstanceValue) => unknown;
}

const noLineMissingReason = ({ kind }: InstanceValue['gameFolder'], inData: InstanceValue['dataFolderPlugins']): string =>
  kind === 'notFound' ? 'The game folder was not found.'
    : inData.kind === 'unreadable' ? `The game folder's Data folder could not be listed: ${inData.reason}` : 'The game folder\'s Data folder has not been read yet.';

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
    description: 'The plugin order, losing first: the plugins the game loads with no line, then each line by its number, then the plugins outside the order (an overridden copy, a file no line names). Each plugin has its origin, its line (null when it has none), whether it is enabled and whether it wins its file name. When it cannot name the plugins the game loads with no line, it refuses in part: noLineMissing is the reason, and the rest is answered.',
    of: ({ plugins, pluginsLoadedWithNoLine, gameFolder, dataFolderPlugins }) => {
      const { loadedWithNoLine, fromLines, others } = pluginOrderOf(
        { plugins, pluginsLoadedWithNoLine: pluginsLoadedWithNoLine ?? [] },
        (address) => ({ ...address, path: '', line: null, enabled: true, winning: true }),
      );
      const answer = {
        plugins: [
          ...loadedWithNoLine.map(({ name, origin }) => ({ name, origin, line: null, enabled: true, winning: true })),
          ...[...fromLines, ...others].map(({ name, origin, line, enabled, winning }) => ({ name, origin, line, enabled, winning })),
        ],
      };
      if (pluginsLoadedWithNoLine !== undefined) return answer;
      const noLineMissing = noLineMissingReason(gameFolder, dataFolderPlugins);
      throw new Refusal(noLineMissing, { ...answer, noLineMissing });
    },
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
