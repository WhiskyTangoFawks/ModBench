import * as vscode from 'vscode';
import { AgentCall, type GestureResult } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { ModlistRepositoryCommands } from '../sourceCommands/modlistRepositoryCommands';

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

async function gitInit(deps: ModlistGestureDeps): Promise<void> {
  const result = await gitInitInToolbox(deps);
  if (!result.applied) deps.reporter.report('error', 'Could not git init.', result.refusal);
}

async function gitInitForAgent(deps: ModlistGestureDeps): Promise<GestureResult<never, string>> {
  const result = await gitInitInToolbox(deps);
  return result.applied ? { applied: true, outcome: { landed: [], refused: [] } } : { applied: false, refusal: result.refusal };
}
