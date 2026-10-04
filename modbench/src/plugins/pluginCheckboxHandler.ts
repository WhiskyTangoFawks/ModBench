import * as vscode from 'vscode';
import type { PluginNode, PluginsTreeNode, PluginsTreeProvider } from './PluginsTreeProvider';
import { forgetRefused, reportPluginsParticipation } from './pluginParticipationCommands';
import { setPluginsParticipation, type PluginsAccess } from '../pluginsCommands/plugins';
import type { Reporter } from '../ports/reporter';

/** Every toggled box, however many and whichever state each asks for, is one call to
 *  `setPluginsParticipation`'s core: one splice, one report. The rows change as ADR-0015
 *  says. */
export async function onPluginCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<PluginsTreeNode>,
  access: PluginsAccess, profile: () => string, reporter: Reporter,
  marks: Pick<PluginsTreeProvider, 'markUnconfirmed' | 'forgetUnconfirmed'>,
): Promise<void> {
  const toggled = e.items
    .filter((item): item is [PluginNode, vscode.TreeItemCheckboxState] => item[0].kind === 'plugin')
    .map(([node, state]) => ({ node, enabled: state === vscode.TreeItemCheckboxState.Checked }));
  if (toggled.length === 0) return;
  for (const { node, enabled } of toggled) marks.markUnconfirmed(node, enabled);
  const entries = toggled.map(({ node, enabled }) => ({ name: node.plugin.name, enabled }));
  const result = await setPluginsParticipation(access, profile(), entries);
  reportPluginsParticipation(result, entries, reporter);
  forgetRefused(result, toggled.map(({ node }) => node), marks);
}
