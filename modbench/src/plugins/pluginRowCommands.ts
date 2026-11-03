import type * as vscode from 'vscode';
import { isRefused, type MEditClient, type PluginAddress, type SourceModIn } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Progress } from '../drivingLib/pausableProgress';
import { columnHeaderOf } from '../wire/columnHeader';
import type { PluginsTreeNode } from './pluginRows';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import { registerAgentGesture, reportPartial, type AgentGesture, type GestureResult } from '../drivingLib/agentGesture';
import type { PluginCommands, SelectionResult } from '../pluginCommands/plugins';
import { selectionArgument } from '../drivingLib/gestureEntry';
import { pickWhereGitHolds } from '../drivingLib/whereGitHolds';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import { pluginRowName } from '../wire/pluginAddress';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { isPluginAddress } from '../wire/messages';
import { isReadFailed } from '../wire/readFailed';

/** The Plugins tree's one progress surface (plugins.md, States, story 2): a spinner over the
 *  view while the work runs, and the view's own message line. */
export interface PluginsViewProgress {
  /** Runs `work` under the spinner, clearing the message on every exit path. */
  while: (work: () => Promise<void>) => Promise<void>;
  /** `undefined` gives the line back to whatever else had something to say. */
  say: (message: string | undefined) => void;
}

/** What decompile needs: the call, the Instance loader's refresh, its confirmation of a replaced change, and how the user
 *  is told. */
export interface DecompileDeps {
  client: Pick<MEditClient, 'decompile' | 'getWorkingTreeStatesBeneath'>;
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
  ask: AskQuestion;
}

interface DecompileGiven {
  readonly plugins: readonly PluginAddress[];
  readonly force: boolean;
  readonly agreesToReplace?: (plugins: readonly PluginAddress[]) => Promise<boolean>;
}

/** commands.md, `decompile`: the plugins of Plugins rows, the selection included, of a record tab's
 *  column header, or of the palette's Plugins selection, asked once. */
export function registerDecompileCommand(
  deps: DecompileDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, DecompileGiven, SelectionResult<PluginAddress>, { force?: boolean }> = {
    fromView: (entry, _option, clicked) => {
      const header = columnHeaderOf(clicked);
      const plugins = header ? [header] : isPluginAddress(clicked) ? [clicked] : selectionArgument(entry, 'plugin').map((node) => node.argument.plugin);
      return plugins.length > 0 ? { plugins, force: false, agreesToReplace: (replaced) => confirmReplace(deps.ask, 'Decompile', replaced) } : undefined;
    },
    fromAgent: ({ argument, options }) => ({ plugins: argument.map(pluginOf), force: options.force === true }),
    run: (given) => runWritingGesture(PLUGINS_KEY_ARGS.view, deps.instance, (progress) =>
      sendAskingOverChanges(deps.client, progress, given, (plugins, force) => decompiled(deps.client, plugins, force))),
    report: (result, { plugins }) => {
      if (result.applied) reportSelection(deps.reporter, result.outcome, plugins.length, { verb: 'decompile', pastTense: 'Decompiled' });
      else deps.reporter.report('error', result.refusal);
    },
  };
  return registerAgentGesture('modbench.plugin.decompile', viewSelection, gesture);
}

/** What decompile and repair needs: the command, mEdit's working-tree states, the Instance loader's refresh, its
 *  confirmation of a replaced change, and how the user is told. */
export interface DecompileAndRepairDeps {
  commands: Pick<PluginCommands, 'decompileAndRepair' | 'outsideSourceMods'>;
  client: Pick<MEditClient, 'getWorkingTreeStatesBeneath'>;
  instance: Pick<Instance, 'refresh' | 'value'>;
  reporter: Reporter;
  ask: AskQuestion;
}

interface DecompileAndRepairGiven extends DecompileGiven {
  readonly where: SourceModIn;
}

/** commands.md, `decompile and repair`: the plugins of Plugins rows, the selection included, of the palette's Plugins
 *  selection, or of a Malformed entry's link in the Problems panel. */
export function registerDecompileAndRepairCommand(
  deps: DecompileAndRepairDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, DecompileAndRepairGiven, GestureResult<PluginAddress>, { force?: boolean }> = {
    fromView: async (entry, _option, clicked) => {
      const plugins = isPluginAddress(clicked) ? [clicked] : selectionArgument(entry, 'plugin').map((node) => node.argument.plugin);
      if (plugins.length === 0) return undefined;
      const where = (await deps.commands.outsideSourceMods(plugins)).length > 0
        ? await pickWhereGitHolds(deps.instance.value.holdsRepository, 'Decompile and repair')
        : 'NewRepository';
      return where === undefined ? undefined : { plugins, force: false, where, agreesToReplace: (replaced) => confirmReplace(deps.ask, 'Decompile and repair', replaced) };
    },
    fromAgent: ({ argument, options }) => ({ plugins: argument.map(pluginOf), force: options.force === true, where: 'NewRepository' }),
    run: async (given) => partialOf(await runWritingGesture(PLUGINS_KEY_ARGS.view, deps.instance, (progress) =>
      sendAskingOverChanges(deps.client, progress, given, (plugins, force) => deps.commands.decompileAndRepair(plugins, force, given.where)))),
    report: (result, { plugins }) => {
      if (result.applied) {
        reportSelection(deps.reporter, result.outcome, plugins.length, { verb: 'decompile and repair', pastTense: 'Decompiled and repaired' });
        reportPartial(deps.reporter, result.partial);
      } else deps.reporter.report('error', result.refusal);
    },
  };
  return registerAgentGesture('modbench.plugin.decompileAndRepair', viewSelection, gesture);
}

function partialOf(result: SelectionResult<PluginAddress>): GestureResult<PluginAddress> {
  if (!result.applied) return result;
  const { notes = [], ...applied } = result;
  return notes.length === 0 ? applied : { ...applied, partial: notes.map((detail) => ({ message: 'Decompile and repair:', detail, severity: 'warning' as const })) };
}

async function confirmReplace(ask: AskQuestion, verb: string, plugins: readonly PluginAddress[]): Promise<boolean> {
  const [only] = plugins;
  const answer = plugins.length === 1 && only !== undefined
    ? await ask(`${verb} "${only.name}" in ${only.origin}? It replaces changes to its source that git does not hold.`,
      { modal: true }, verb)
    : await ask(`${verb} ${plugins.length} plugins? They replace changes to their source that git does not hold.`,
      { modal: true, detail: plugins.map(pluginRowName).join('\n') }, verb);
  return answer === verb;
}

async function withChangesGitDoesNotHold(
  client: Pick<MEditClient, 'getWorkingTreeStatesBeneath'>, plugins: readonly PluginAddress[],
): Promise<PluginAddress[]> {
  const states = await Promise.all(plugins.map((plugin) => client.getWorkingTreeStatesBeneath(plugin)));
  return plugins.filter((_, index) => {
    const beneath = states[index];
    return beneath !== undefined && !isReadFailed(beneath) && beneath.plugin.some((state) => state !== 'None');
  });
}

type SendPlugins = (plugins: readonly PluginAddress[], force: boolean) => Promise<SelectionResult<PluginAddress>>;

// commands.md, Principles, Confirm what destroys: the plugins with changes git holds nowhere go forced, the rest unforced.
async function sendAskingOverChanges(
  client: Pick<MEditClient, 'getWorkingTreeStatesBeneath'>, progress: Progress,
  { plugins, force, agreesToReplace }: DecompileGiven, send: SendPlugins,
): Promise<SelectionResult<PluginAddress>> {
  const replacing = agreesToReplace === undefined || force ? [] : await withChangesGitDoesNotHold(client, plugins);
  if (replacing.length === 0) return sendBatches([{ plugins, force }], send);
  progress.waiting();
  const agreed = await agreesToReplace?.(replacing);
  progress.working();
  if (agreed !== true) return { applied: true, outcome: { landed: [], refused: [] } };
  const rest = plugins.filter((plugin) => !replacing.includes(plugin));
  return sendBatches([{ plugins: replacing, force: true }, { plugins: rest, force: false }], send);
}

async function decompiled(
  client: Pick<MEditClient, 'decompile'>, plugins: readonly PluginAddress[], force: boolean,
): Promise<SelectionResult<PluginAddress>> {
  const answer = await client.decompile(plugins, force);
  return isRefused(answer) ? { applied: false, refusal: answer.message } : { applied: true, outcome: answer };
}

interface SendBatch { readonly plugins: readonly PluginAddress[]; readonly force: boolean }

async function sendBatches(batches: readonly SendBatch[], send: SendPlugins): Promise<SelectionResult<PluginAddress>> {
  const answered: { batch: SendBatch; answer: SelectionResult<PluginAddress> }[] = [];
  for (const batch of batches.filter(({ plugins }) => plugins.length > 0)) {
    const answer = await send(batch.plugins, batch.force);
    if (!answer.applied && answered.length === 0) return answer;
    answered.push({ batch, answer });
  }
  const notes = [...new Set(answered.flatMap(({ answer }) => answer.applied ? answer.notes ?? [] : []))];
  return {
    applied: true,
    outcome: {
      landed: answered.flatMap(({ answer }) => answer.applied ? answer.outcome.landed : []),
      refused: answered.flatMap(({ batch, answer }) => answer.applied
        ? answer.outcome.refused
        : batch.plugins.map((item) => ({ item, reason: answer.refusal }))),
    },
    ...notes.length === 0 ? {} : { notes },
  };
}

function reportSelection(
  reporter: Reporter, outcome: SelectionOutcome<PluginAddress>, total: number, { verb, pastTense }: { verb: string; pastTense: string },
): void {
  const [refused] = outcome.refused;
  if (refused !== undefined) {
    const what = total === 1 ? `"${refused.item.name}"` : `${outcome.refused.length} of ${total} plugins`;
    reporter.selectionOutcome(`Could not ${verb} ${what}.`, outcome, pluginRowName);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only === undefined) return;
  reporter.landed(more.length === 0 ? `${pastTense} "${only.name}".` : `${pastTense} ${outcome.landed.length} plugins.`);
}
