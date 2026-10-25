import * as vscode from 'vscode';
import { AgentCall, type GestureResult } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import type { CheckForUpdates, UpdateChecked } from '../modCommands/checkForUpdates';
import type { Reporter } from '../ports/reporter';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { MODS_KEY_ARGS } from './gestureEntry';
import { everyModHere, modsOfAgent, modsToRun, type ModsToRun, type ModsToRunDeps } from './modsToRun';

export interface CheckForUpdatesDeps extends Omit<ModsToRunDeps, 'toolboxView'> {
  commands: { checkForUpdates: CheckForUpdates };
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporter: Reporter;
}

const isAgentCall = (value: unknown): value is AgentCall => value instanceof AgentCall;

// mods.md offers the gesture on the Mods view only, so a gesture with no row runs under it.
export function registerCheckForUpdatesGestures(given: CheckForUpdatesDeps): vscode.Disposable[] {
  const deps = { ...given, toolboxView: MODS_KEY_ARGS.view };
  return [
    vscode.commands.registerCommand('modbench.mod.checkForUpdates', (clicked?: unknown, selected?: readonly unknown[]) =>
      (isAgentCall(clicked) ? checkForAgent(deps, clicked) : checkForView(deps, modsToRun(deps, clicked, selected, 'modsOnly')))),
    vscode.commands.registerCommand('modbench.modList.checkForUpdatesHere', () => checkForView(deps, everyModHere(deps, 'modsOnly'))),
  ];
}

async function checkForView(
  { commands, instance, reporter }: CheckForUpdatesDeps, { mods, refused, view }: ModsToRun,
): Promise<void> {
  await runWritingGesture(view, instance, async () => {
    const result = await commands.checkForUpdates(mods);
    if (!result.applied) { reporter.report('error', result.refusal); return; }
    const notAsked: ItemRefusal<string>[] = [
      ...result.outcome.refused.map(({ item, reason }) => ({ item: item.name, reason })),
      ...refused,
    ];
    const updates = result.outcome.landed.filter(({ updateAvailable }) => updateAvailable === true).length;
    const line = `Check for updates: ${updates} ${updates === 1 ? 'mod has' : 'mods have'} an update, ${notAsked.length} could not be asked about.`;
    if (notAsked.length === 0) reporter.landed(line);
    else reporter.report('warning', line, notAsked.map(({ item, reason }) => `"${item}" (${reason})`).join('\n'));
  });
}

async function checkForAgent(
  { commands, instance }: CheckForUpdatesDeps, { argument }: AgentCall,
): Promise<GestureResult<UpdateChecked>> {
  const result = await runWritingGesture(MODS_KEY_ARGS.view, instance, () => commands.checkForUpdates(modsOfAgent(argument, instance.value, 'modsOnly')));
  return result.applied ? { applied: true, outcome: result.outcome } : { applied: false, refusal: result.refusal };
}
