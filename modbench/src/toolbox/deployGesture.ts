import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { DeployCommands, DeployResult, PurgeResult } from '../instanceCommands/deploy';
import { AgentCall, registerWritingCommand, answeredToAgent, deployedPathsOf, isAgentCall, reportPartial, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import { deployFailures, deployWarnings } from '../drivingLib/deployProblems';
import { MOVE_TO_OVERWRITE, unmanagedProblems } from './unmanagedProblems';
import { registerDeployTask } from './deployTask';
import { TOOLBOX_VIEW } from './toolboxCommands';

interface DeployGestureDeps {
  commands: Pick<DeployCommands, 'deploy' | 'purge' | 'moveToOverwrite' | 'unmanaged'>;
  instance: Pick<Instance, 'landed' | 'sequence' | 'refresh' | 'subscribe'>;
  reporterFor: (tag: string) => Reporter;
}

export function registerDeployCommands({ commands, instance, reporterFor }: DeployGestureDeps): vscode.Disposable[] {
  const reporter = reporterFor('deploy');
  const collection = vscode.languages.createDiagnosticCollection('modbench-deployment-unmanaged');
  const problems = unmanagedProblems(collection);
  let leftOut: readonly { path: string; winner: string }[] = [];
  const publishProblems = async (): Promise<void> => {
    const held = await commands.unmanaged();
    if (held.applied) problems.publish(held.unmanaged, leftOut);
    else collection.clear();
  };
  // A recompute reads the disk again, on window focus and on refresh: the files the user changed by hand are read there (ADR-0003).
  const subscription = instance.subscribe(() => { void publishProblems(); });
  const deploy = async (reportsItself: boolean): Promise<DeployResult> => {
    const { files, plugins, gameName } = await instance.landed();
    const result = await commands.deploy(instance.sequence === 0 ? undefined : { files, plugins, gameName });
    leftOut = result.applied ? result.leftOut : [];
    await publishProblems();
    if (reportsItself) return result;
    if (!result.applied) {
      reporter.report('error', 'Could not deploy.', result.refusal);
      return result;
    }
    for (const { message, detail } of [...deployFailures(result), ...deployWarnings(result)]) reporter.report('warning', message, detail);
    return result;
  };
  const purge = async (called: unknown): Promise<GestureResult<never, string> | undefined> => {
    const result = await commands.purge();
    leftOut = [];
    await publishProblems();
    if (called instanceof AgentCall) return answeredToAgent(result, result.applied ? purgePartials(result) : []);
    if (!result.applied) {
      reporter.report('error', 'Could not purge.', result.refusal);
      return undefined;
    }
    if (result.unmanaged.length > 0) {
      reporter.shownOnSurface('warning', 'The deployment folder holds files purge did not remove:', result.unmanaged.join(', '));
      reporter.report('warning', `The deployment folder holds ${result.unmanaged.length} files purge did not remove, each named in the Output.`);
    }
    reportPartial(reporter, purgeLeftovers(result));
    return undefined;
  };
  // The game folder can be the deployment folder (deployment-hardlink.md, The deployment folder, story 4), and
  // the instance value reads its Data folder.
  return [
    registerDeployTask(reporter),
    registerWritingCommand('modbench.instance.deploy', (called?: unknown) => runWritingGesture('modbench.instance.deploy', TOOLBOX_VIEW, instance, () => deploy(called instanceof AgentCall))),
    registerWritingCommand('modbench.instance.purge', (called?: unknown) => runWritingGesture('modbench.instance.purge', TOOLBOX_VIEW, instance, () => purge(called))),
    registerMoveToOverwriteCommand({ commands, instance, reporter }, publishProblems),
    collection,
    subscription,
  ];
}

const warning = (message: string, detail: string): PartialFailure => ({ message, detail, severity: 'warning' });

function purgeLeftovers({ leftRenamed, unfinished }: Extract<PurgeResult, { applied: true }>): PartialFailure[] {
  return [
    ...(leftRenamed.length > 0 ? [warning('Purge left each plugins.txt deploy renamed, which is yours to put back:', leftRenamed.join(', '))] : []),
    ...(unfinished.length > 0 ? [warning('Purge landed, and could not finish:', unfinished.join(', '))] : []),
  ];
}

function purgePartials(result: Extract<PurgeResult, { applied: true }>): PartialFailure[] {
  const { unmanaged } = result;
  return [
    ...(unmanaged.length > 0 ? [warning('The deployment folder holds files purge did not remove:', unmanaged.join(', '))] : []),
    ...purgeLeftovers(result),
  ];
}

const refusedWarning = (refused: readonly { item: string; reason: string }[]) =>
  warning('Not moved:', refused.map(({ item, reason }) => `${JSON.stringify(item)} (${reason})`).join(', '));

const leftWarning = (left: readonly string[]) => warning('Left in the deployment folder, because no mod file lands at their path:', left.join(', '));

function pathsOf(called: unknown): readonly string[] | undefined {
  if (isAgentCall(called)) {
    const paths = deployedPathsOf(called);
    return paths.length === 0 ? undefined : paths;
  }
  return Array.isArray(called) && called.every((path) => typeof path === 'string') ? called : undefined;
}

function registerMoveToOverwriteCommand({ commands, instance, reporter }: Omit<DeployGestureDeps, 'reporterFor'> & { reporter: Reporter }, publishProblems: () => Promise<void>): vscode.Disposable {
  const move = async (called: unknown): Promise<GestureResult<string> | undefined> => {
    const result = await commands.moveToOverwrite(pathsOf(called));
    await publishProblems();
    if (!result.applied) {
      if (called instanceof AgentCall) return answeredToAgent(result);
      reporter.report('error', 'Could not move to Overwrite.', result.refusal);
      return undefined;
    }
    const partial = result.left.length > 0 ? [leftWarning(result.left)] : [];
    if (called instanceof AgentCall) return { applied: true, outcome: { landed: result.landed, refused: result.refused }, ...(partial.length === 0 ? {} : { partial }) };
    reportPartial(reporter, result.refused.length > 0 ? [refusedWarning(result.refused), ...partial] : partial);
    return undefined;
  };
  return registerWritingCommand(MOVE_TO_OVERWRITE, (called?: unknown) => runWritingGesture(MOVE_TO_OVERWRITE, TOOLBOX_VIEW, instance, () => move(called)));
}
