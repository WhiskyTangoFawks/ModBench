import { pluginOrderOf, unplaced } from '../instanceLoader/pluginOrder';
import { Refusal } from '../drivingLib/refusal';
import { originShown, type AgentValue } from './notRestored';

const noLineMissingReason = ({ kind }: AgentValue['gameFolder'], inData: AgentValue['dataFolderPlugins']): string =>
  kind === 'notFound' ? 'The game folder was not found.'
    : inData.kind === 'unreadable' ? `The game folder's Data folder could not be listed: ${inData.reason}` : 'The game folder\'s Data folder has not been read yet.';

const undecidedIn = ({ notRestored }: AgentValue): { lines: readonly string[]; reason: string | undefined } | undefined =>
  notRestored !== undefined && notRestored.undecided.length > 0 ? { lines: notRestored.undecided, reason: notRestored.unread } : undefined;

export const LIST_PLUGINS = {
  name: 'list_plugins',
  description: 'The plugin order, losing first: the plugins the game loads with no line, then each line by its number, then the plugins outside the order (an overridden copy, a file no line names). '
    + 'Each plugin has its origin, its line (null when it has none), whether it is enabled and whether it wins its file name. '
    + 'The origin of a line whose file is not on disk yet is the mod whose manifest names it. '
    + 'When it cannot name the plugins the game loads with no line, it refuses in part: noLineMissing is the reason, and the rest is answered. '
    + 'When it cannot read the manifests, it refuses in part too: notRestoredUndecided names the lines whose origin it could not decide, and why.',
  of: (value: AgentValue) => {
    const { plugins, pluginsLoadedWithNoLine, gameFolder, dataFolderPlugins } = value;
    const { loadedWithNoLine, fromLines, others } = pluginOrderOf(
      { plugins, pluginsLoadedWithNoLine: pluginsLoadedWithNoLine ?? [] },
      unplaced,
    );
    const answer = {
      plugins: [
        ...loadedWithNoLine.map(({ name, origin }) => ({ name, origin, line: null, enabled: true, winning: true })),
        ...[...fromLines, ...others].map((plugin) => ({ name: plugin.name, origin: originShown(value, plugin), line: plugin.line, enabled: plugin.enabled, winning: plugin.winning })),
      ],
    };
    const noLineMissing = pluginsLoadedWithNoLine === undefined ? noLineMissingReason(gameFolder, dataFolderPlugins) : undefined;
    const notRestoredUndecided = undecidedIn(value);
    if (noLineMissing === undefined && notRestoredUndecided === undefined) return answer;
    const undecidedReason = notRestoredUndecided && `The origin of ${notRestoredUndecided.lines.join(', ')} could not be decided: ${notRestoredUndecided.reason}`;
    throw new Refusal(
      [noLineMissing, undecidedReason].filter((reason) => reason !== undefined).join(' '),
      { ...answer, ...(noLineMissing && { noLineMissing }), ...(notRestoredUndecided && { notRestoredUndecided }) },
    );
  },
};
