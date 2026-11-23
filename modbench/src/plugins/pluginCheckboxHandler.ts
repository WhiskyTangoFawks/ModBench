import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { PluginNode, PluginsTreeNode } from './pluginRows';
import { PLUGINS_KEY_ARGS } from './gestureEntry';
import { reportPluginsParticipation } from './pluginParticipationCommands';
import { asViewCall, RefusedWrite, runWritingGesture } from '../drivingLib/writingGesture';
import type { PluginCommands } from '../pluginCommands/plugins';
import type { Reporter } from '../ports/reporter';
import type { PluginAddress } from '../wire/pluginAddress';

/** The boxes toggled to one state are one call to `setPluginsParticipation`'s core: one splice, one report. Each box
 *  clicked shows the value once the call ends, whatever its outcome. */
export async function onPluginCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<PluginsTreeNode>,
  commands: Pick<PluginCommands, 'setPluginsParticipation'>, reporter: Reporter, instance: Pick<Instance, 'refresh'>,
  restore: (plugins: readonly PluginAddress[]) => void,
): Promise<void> {
  const clicked = e.items.filter((item): item is [PluginNode, vscode.TreeItemCheckboxState] => item[0].kind === 'plugin');
  if (clicked.length === 0) return;
  const entries = clicked.map(([node, state]) => ({ name: node.plugin.name, enabled: state === vscode.TreeItemCheckboxState.Checked }));
  const batches = [true, false].map((enabled) => ({ enabled, batch: entries.filter((entry) => entry.enabled === enabled) })).filter(({ batch }) => batch.length > 0);
  try {
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
  } finally {
    restore(clicked.map(([node]) => node.argument.plugin));
  }
}
