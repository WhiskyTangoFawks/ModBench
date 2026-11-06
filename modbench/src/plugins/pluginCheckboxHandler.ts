import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { PluginNode, PluginsTreeNode } from './pluginRows';
import { PLUGINS_KEY_ARGS } from './gestureEntry';
import { reportPluginsParticipation } from './pluginParticipationCommands';
import { asViewCall, RefusedWrite, runWritingGesture } from '../drivingLib/writingGesture';
import type { PluginCommands } from '../pluginCommands/plugins';
import type { Reporter } from '../ports/reporter';

/** The boxes toggled to one state are one call to
 *  `setPluginsParticipation`'s core: one splice, one report. The rows change as ADR-0015
 *  says. */
export async function onPluginCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<PluginsTreeNode>,
  commands: Pick<PluginCommands, 'setPluginsParticipation'>, reporter: Reporter, instance: Pick<Instance, 'refresh'>,
): Promise<void> {
  const entries = e.items
    .filter((item): item is [PluginNode, vscode.TreeItemCheckboxState] => item[0].kind === 'plugin')
    .map(([node, state]) => ({ name: node.plugin.name, enabled: state === vscode.TreeItemCheckboxState.Checked }));
  if (entries.length === 0) return;
  const batches = [true, false].map((enabled) => ({ enabled, batch: entries.filter((entry) => entry.enabled === enabled) })).filter(({ batch }) => batch.length > 0);
  await asViewCall(async () => {
    for (const [index, { enabled, batch }] of batches.entries()) {
      try {
        await runWritingGesture(enabled ? 'modbench.plugin.enable' : 'modbench.plugin.disable', PLUGINS_KEY_ARGS.view, instance, async () => {
          const result = await commands.setPluginsParticipation(batch);
          reportPluginsParticipation(result, batch, reporter);
        });
      } catch (e) {
        if (e instanceof RefusedWrite && index === 0 && batches.length > 1) throw new RefusedWrite(`${e.message} Nothing was enabled or disabled.`);
        throw e;
      }
    }
  });
}
