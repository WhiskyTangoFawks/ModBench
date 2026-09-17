import * as vscode from 'vscode';
import type { Instance } from './instance/instance';
import { deployMods, purgeMods, type DeploymentCommandResult } from './deploy/deployment';
import { switchProfile } from './instanceCommands/profile';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import { refuse } from './ports/refuse';

// The task type the Launch… command picks from. Nothing contributes one yet, so the pick is
// empty until a task provider or a tasks.json entry declares this type.
const LAUNCH_TASK_TYPE = 'modbench';

export interface ToolboxCommandDeps {
  instanceRoot: string;
  /** ADR-0015: the profile, the game directory and the file winners all come from the value. */
  instance: Pick<Instance, 'value'>;
  outputChannel: vscode.LogOutputChannel;
  updateProfileDescription: () => Promise<void>;
  reporterFor: (tag: string) => Reporter;
  /** The deployment's own confirmation asks through this. */
  ask: AskQuestion;
}

// Keyed on the Instance's own `deployed` field, so a directory that already has a manifest
// never asks again.
export const DEPLOY_CONFIRM_BUTTON = 'Deploy';

export const DEPLOY_DECLINED = 'Deploy declined — Modbench was not confirmed as the deployer; nothing was written.';

async function confirmFirstDeploy(ask: AskQuestion): Promise<boolean> {
  const choice = await ask(
    'Modbench has never deployed into this game directory. Deploying now hardlinks your enabled ' +
      'mods into Data/ and makes Modbench the deployer — if MO2 or another tool also deploys here, ' +
      'the two will conflict. Continue?',
    { modal: true },
    DEPLOY_CONFIRM_BUTTON,
  );
  return choice === DEPLOY_CONFIRM_BUTTON;
}

// `wrote` false means the command reported its own abort, so the success message is withheld
// rather than announcing a deployment that did not happen.
async function runDeployment(
  reporter: Reporter, failure: string, success: string, command: () => Promise<DeploymentCommandResult>,
): Promise<void> {
  let outcome: DeploymentCommandResult;
  try {
    outcome = await command();
  } catch (err) {
    outcome = refuse(err);
  }
  if (!outcome.applied) {
    reporter.report('error', failure, outcome.refusal);
    return;
  }
  for (const warning of outcome.warnings ?? []) reporter.report('warning', warning.message, warning.detail);
  if (!outcome.wrote) return;
  // The manifest lands under mods/, which the Instance watches — its own recompute is what moves
  // the Toolbox's deployment row, never this command.
  reporter.landed(success);
}

// The four instance-wide gestures the Toolbox view owns (docs/specs/containers.md rule 1),
// registered for the box that draws them.
export function registerToolboxCommands(deps: ToolboxCommandDeps): vscode.Disposable[] {
  const { instanceRoot, instance, outputChannel, updateProfileDescription, reporterFor, ask } = deps;
  const deployReporter = reporterFor('deploy');
  const profileReporter = reporterFor('switchProfile');
  const launchReporter = reporterFor('launchTarget');
  return [
    vscode.commands.registerCommand('modbench.toolbox.switchProfile', async () => {
      const { activeProfile: active, profiles } = instance.value;
      const picked = await vscode.window.showQuickPick(
        profiles.map((p) => ({ label: p, description: p === active ? 'current' : undefined })),
        { placeHolder: 'Switch profile' },
      );
      if (!picked || picked.label === active) return;
      const outcome = await switchProfile(instanceRoot, picked.label, profiles);
      if (!outcome.applied) {
        profileReporter.report('error', 'Failed to switch profile.', outcome.refusal);
        return;
      }
      void updateProfileDescription();
      // ADR-0013/ADR-0015: the write lands in ModOrganizer.ini, which the Instance already
      // watches — its own recompute reaches the load order and the Toolbox's profile row.
    }),
    vscode.commands.registerCommand('modbench.toolbox.deploy', () =>
      runDeployment(deployReporter, 'Deploy failed.', 'Mods deployed.', async () => {
        if (!instance.value.deployed && !(await confirmFirstDeploy(ask))) {
          return { applied: false, refusal: DEPLOY_DECLINED };
        }
        return deployMods(instanceRoot, instance.value);
      })),
    vscode.commands.registerCommand('modbench.toolbox.purge', () =>
      runDeployment(deployReporter, 'Purge failed.', 'Deployed mods purged.', () =>
        purgeMods(instanceRoot, instance.value))),
    // One affordance however many executables exist, because MO2's registry decides what is
    // launchable. Tasks are read at invocation, so an executable added in MO2 appears without a
    // reload; resolving a binary here would lock the command to one game.
    vscode.commands.registerCommand('modbench.toolbox.launch', async () => {
      const tasks = await vscode.tasks.fetchTasks({ type: LAUNCH_TASK_TYPE });
      if (tasks.length === 0) {
        outputChannel.info('[toolbox] Launch…: no launchable tasks contributed');
        launchReporter.landed(
          'No launch targets — add an executable to MO2\'s executables list and it appears here.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        tasks.map((task) => ({ label: task.name, task })),
        { placeHolder: 'Launch' },
      );
      if (!picked) return;
      await vscode.tasks.executeTask(picked.task);
    }),
  ];
}
