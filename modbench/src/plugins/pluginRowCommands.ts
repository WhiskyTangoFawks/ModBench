import type * as vscode from 'vscode';
import { isRefused, type MEditClient, type PluginAddress } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { columnHeaderOf } from '../wire/columnHeader';
import type { PluginsTreeNode } from './pluginRows';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import { registerAgentGesture, type AgentGesture } from '../drivingLib/agentGesture';
import type { PluginCommands, SelectionResult } from '../pluginCommands/plugins';
import { selectionArgument } from '../drivingLib/gestureEntry';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import { pluginRowName } from '../wire/pluginAddress';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { previewLines } from '../pluginCommands/decompileAndRepair';
import { isPluginAddress } from '../wire/messages';

/** The Plugins tree's one progress surface (plugins.md, States, story 2): a spinner over the
 *  view while the work runs, and the view's own message line. */
export interface PluginsViewProgress {
  /** Runs `work` under the spinner, clearing the message on every exit path. */
  while: (work: () => Promise<void>) => Promise<void>;
  /** `undefined` gives the line back to whatever else had something to say. */
  say: (message: string | undefined) => void;
}

/** What decompile needs: the call, the Instance loader's refresh, its one confirmation, and how the user
 *  is told. */
export interface DecompileDeps {
  client: Pick<MEditClient, 'decompile'>;
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
  ask: AskQuestion;
}

interface DecompileGiven {
  readonly plugins: readonly PluginAddress[];
  readonly force: boolean;
}

/** commands.md, `decompile`: the plugins of Plugins rows, the selection included, of a record tab's
 *  column header, or of the palette's Plugins selection, asked once. */
export function registerDecompileCommand(
  deps: DecompileDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, DecompileGiven, SelectionResult<PluginAddress>, { force?: boolean }> = {
    fromView: async (entry, _option, clicked) => {
      const header = columnHeaderOf(clicked);
      const plugins = header ? [header] : selectionArgument(entry, 'plugin').map((node) => node.argument.plugin);
      return plugins.length > 0 && await confirmDecompile(deps.ask, plugins) ? { plugins, force: true } : undefined;
    },
    fromAgent: ({ argument, options }) => ({ plugins: argument.map(pluginOf), force: options.force === true }),
    run: ({ plugins, force }) => runWritingGesture(PLUGINS_KEY_ARGS.view, deps.instance, async () => {
      const outcome = await deps.client.decompile(plugins, force);
      return isRefused(outcome) ? { applied: false, refusal: outcome.message } : { applied: true, outcome };
    }),
    report: (result, { plugins }) => {
      if (result.applied) reportDecompiled(deps.reporter, result.outcome, plugins.length);
      else deps.reporter.report('error', result.refusal);
    },
  };
  return registerAgentGesture('modbench.plugin.decompile', viewSelection, gesture);
}

/** What decompile and repair needs: the command, the Instance loader's refresh, the Output line each preview's changes
 *  are named on, and how the user is told. */
export interface DecompileAndRepairDeps {
  commands: Pick<PluginCommands, 'decompileAndRepair'>;
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
  log: (line: string) => void;
}

/** commands.md, `decompile and repair`: the plugins of Plugins rows, the selection included, of the palette's Plugins
 *  selection, or of a Malformed entry's link in the Problems panel. No prompt: a repair that drops data is refused. */
export function registerDecompileAndRepairCommand(
  deps: DecompileAndRepairDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, DecompileGiven, SelectionResult<PluginAddress>, { force?: boolean }> = {
    fromView: (entry, _option, clicked) => {
      const plugins = isPluginAddress(clicked) ? [clicked] : selectionArgument(entry, 'plugin').map((node) => node.argument.plugin);
      return plugins.length > 0 ? { plugins, force: false } : undefined;
    },
    fromAgent: ({ argument, options }) => ({ plugins: argument.map(pluginOf), force: options.force === true }),
    run: ({ plugins, force }) => runWritingGesture(PLUGINS_KEY_ARGS.view, deps.instance, () =>
      deps.commands.decompileAndRepair(plugins, force, (preview) => { previewLines(preview).forEach(deps.log); })),
    report: (result, { plugins }) => {
      if (result.applied) reportRepaired(deps.reporter, result.outcome, plugins.length);
      else deps.reporter.report('error', result.refusal);
    },
  };
  return registerAgentGesture('modbench.plugin.decompileAndRepair', viewSelection, gesture);
}

function reportRepaired(reporter: Reporter, outcome: SelectionOutcome<PluginAddress>, total: number): void {
  const [refused] = outcome.refused;
  if (refused !== undefined) {
    const what = total === 1 ? `"${refused.item.name}"` : `${outcome.refused.length} of ${total} plugins`;
    reporter.selectionOutcome(`Could not decompile and repair ${what}.`, outcome, pluginRowName);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only === undefined) return;
  reporter.landed(more.length === 0 ? `Decompiled and repaired "${only.name}".` : `Decompiled and repaired ${outcome.landed.length} plugins.`);
}

// plugins.md, Decompile: one confirmation for the selection, naming the plugins; it replaces
// what the working tree holds (commands.md, Confirm what destroys).
async function confirmDecompile(ask: AskQuestion, plugins: readonly PluginAddress[]): Promise<boolean> {
  const [only] = plugins;
  const answer = plugins.length === 1 && only !== undefined
    ? await ask(`Decompile "${only.name}" in ${only.origin}? Decompile replaces its source in the working tree from its bytes.`,
      { modal: true }, 'Decompile')
    : await ask(`Decompile ${plugins.length} plugins? Decompile replaces their source in the working tree from their bytes.`,
      { modal: true, detail: plugins.map(pluginRowName).join('\n') }, 'Decompile');
  return answer === 'Decompile';
}

function reportDecompiled(reporter: Reporter, outcome: SelectionOutcome<PluginAddress>, total: number): void {
  const [refused] = outcome.refused;
  if (refused !== undefined) {
    const what = total === 1 ? `"${refused.item.name}"` : `${outcome.refused.length} of ${total} plugins`;
    reporter.selectionOutcome(`Could not decompile ${what}.`, outcome, pluginRowName);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only === undefined) return;
  reporter.landed(more.length === 0 ? `Decompiled "${only.name}".` : `Decompiled ${outcome.landed.length} plugins.`);
}
