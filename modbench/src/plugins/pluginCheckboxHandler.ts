import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { PluginNode, PluginsTreeNode } from './pluginRows';
import { PLUGINS_KEY_ARGS } from './gestureEntry';
import { reportPluginsParticipation } from './pluginParticipationCommands';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { PluginsCommands } from '../pluginsCommands/plugins';
import type { Reporter } from '../ports/reporter';

/** Every toggled box, however many and whichever state each asks for, is one call to
 *  `setPluginsParticipation`'s core: one splice, one report. The rows change as ADR-0015
 *  says. */
export async function onPluginCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<PluginsTreeNode>,
  commands: Pick<PluginsCommands, 'setPluginsParticipation'>, profile: () => string, reporter: Reporter, instance: Pick<Instance, 'refresh'>,
): Promise<void> {
  const entries = e.items
    .filter((item): item is [PluginNode, vscode.TreeItemCheckboxState] => item[0].kind === 'plugin')
    .map(([node, state]) => ({ name: node.plugin.name, enabled: state === vscode.TreeItemCheckboxState.Checked }));
  if (entries.length === 0) return;
  await runWritingGesture(PLUGINS_KEY_ARGS.view, instance, async () => {
    const result = await commands.setPluginsParticipation(profile(), entries);
    reportPluginsParticipation(result, entries, reporter);
  });
}
