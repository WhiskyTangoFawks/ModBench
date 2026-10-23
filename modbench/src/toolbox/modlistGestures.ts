import * as vscode from 'vscode';
import { AgentCall, reportPartial, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { GitInitResult, ModlistRepositoryCommands } from '../sourceCommands/modlistRepositoryCommands';

import { TOOLBOX_VIEW } from './toolboxCommands';

interface ModlistGestureDeps {
  commands: Pick<ModlistRepositoryCommands, 'gitInit'>;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporter: Reporter;
}

export function registerModlistCommands(deps: ModlistGestureDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.modlist.gitInit', (clicked?: unknown) => (clicked instanceof AgentCall ? gitInitForAgent(deps) : gitInit(deps))),
  ];
}

const gitInitInToolbox = ({ commands, instance }: ModlistGestureDeps) =>
  runWritingGesture(TOOLBOX_VIEW, instance, () => commands.gitInit());

const partialOf = ({ pushRefusalNotWritten, pathTokensNotWritten }: Extract<GitInitResult, { applied: true }>): PartialFailure[] => [
  ...(pushRefusalNotWritten === undefined ? [] : [`a push of a pin its source mod's remote lacks is not refused: ${pushRefusalNotWritten}`]),
  ...(pathTokensNotWritten === undefined ? [] : [`this machine's paths are not in place of every path token: ${pathTokensNotWritten}`]),
].map((detail) => ({ message: 'Git init:', detail, severity: 'warning' as const }));

async function gitInit(deps: ModlistGestureDeps): Promise<void> {
  const result = await gitInitInToolbox(deps);
  if (result.applied) reportPartial(deps.reporter, partialOf(result));
  else deps.reporter.report('error', 'Could not git init.', result.refusal);
}

async function gitInitForAgent(deps: ModlistGestureDeps): Promise<GestureResult<never, string>> {
  const result = await gitInitInToolbox(deps);
  if (!result.applied) return { applied: false, refusal: result.refusal };
  const partial = partialOf(result);
  return { applied: true, outcome: { landed: [], refused: [] }, ...(partial.length === 0 ? {} : { partial }) };
}
