import { inGameOrder, pluginOrderOf, unplaced } from '../instanceLoader/pluginOrder';
import { Refusal } from '../drivingLib/refusal';
import type { PluginsShown } from '../drivingLib/pluginsShown';
import { originShown, type AgentValue } from './notRestored';

const noLineMissingReason = ({ kind }: AgentValue['gameFolder'], inData: AgentValue['dataFolderPlugins']): string =>
  kind === 'notFound' ? 'The game folder was not found.'
    : inData.kind === 'unreadable' ? `The game folder's Data folder could not be listed: ${inData.reason}` : 'The game folder\'s Data folder has not been read yet.';

const undecidedIn = ({ notRestored }: AgentValue): { lines: readonly string[]; reason: string | undefined } | undefined =>
  notRestored !== undefined && notRestored.undecided.length > 0 ? { lines: notRestored.undecided, reason: notRestored.unread } : undefined;

export const LIST_PLUGINS = {
  name: 'list_plugins',
  of: (value: AgentValue, view: PluginsShown) => {
    const { plugins, pluginsLoadedWithNoLine, gameFolder, dataFolderPlugins, blueprintLoadsLast } = value;
    const { loadedWithNoLine, fromLines, others } = pluginOrderOf(
      { plugins, pluginsLoadedWithNoLine: pluginsLoadedWithNoLine ?? [] },
      unplaced,
    );
    const shownOrder = [...inGameOrder(loadedWithNoLine, fromLines, (plugin) => view.isBlueprint(plugin), blueprintLoadsLast), ...others];
    const answer = {
      plugins: shownOrder.map((plugin) => ({
        name: plugin.name, origin: originShown(value, plugin), line: plugin.line, enabled: plugin.enabled, winning: plugin.winning, ...view.shown(plugin),
      })),
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
