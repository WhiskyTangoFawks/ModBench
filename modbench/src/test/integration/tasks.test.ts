import * as assert from 'assert';
import * as vscode from 'vscode';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'mocha';
import { present } from '../../ports/present';
import { stepTasks } from '../../sourceCommands/steps';
import { hostTasks } from '../../tasks';

const TEST_PORT = present(process.env.MODBENCH_TEST_PORT, 'the port .vscode-test.mjs hands the run');

const POWERSHELL_FAILURE_CODE = 1;
const RUNS: readonly { label: string; args: string[]; ran: string; code: number }[] = [
  { label: 'Process step', args: ['textures', '3'], ran: 'textures 3', code: 3 },
  { label: 'Shell step', args: ['textures', `${POWERSHELL_FAILURE_CODE}`], ran: `textures ${POWERSHELL_FAILURE_CODE}`, code: POWERSHELL_FAILURE_CODE },
  { label: 'Shell line step', args: [], ran: `${POWERSHELL_FAILURE_CODE}`, code: POWERSHELL_FAILURE_CODE },
];

describe('a step\'s user task, as .vscode-test.mjs writes it: a script that records its arguments and MEDIT_PORT in its folder and exits with the last', () => {
  const tasks = stepTasks(hostTasks);
  const folders: string[] = [];
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

  it('is among the labels of this machine\'s user tasks, and a workspace task is not', async () => {
    const labels = await tasks.labels();

    assert.deepStrictEqual([...RUNS.map(({ label }) => label), 'Workspace step'].map((label) => labels.includes(label)), [true, true, true, false], `the labels were ${labels.join(', ')}`);
  });

  it('runs each kind of user task, never the workspace task of its label, in the folder with the step\'s arguments after its own and medit\'s port, and answers its exit code', async () => {
    const ran = await Promise.all(RUNS.map(async ({ label, args }) => {
      const folder = mkdtempSync(path.join(os.tmpdir(), 'modbench-step-'));
      folders.push(folder);
      const why = await tasks.whyStepsFailed([{ task: label, args }], folder);
      return [why, readFileSync(path.join(folder, 'ran.txt'), 'utf8')];
    }));

    assert.deepStrictEqual(ran, RUNS.map(({ label, ran: recorded, code }) => [`step '${label}' exited with code ${code}`, `${recorded}\n${TEST_PORT}`]));
  });
});

describe('a build task in a chain', () => {
  const root = (): string => present(vscode.workspace.workspaceFolders?.[0], 'the workspace folder').uri.fsPath;
  const labelled = async (label: string): Promise<vscode.Task> => present((await vscode.tasks.fetchTasks()).find((task) => task.name === label), `the task ${label}`);
  const ended = (execution: vscode.TaskExecution): Promise<void> => new Promise((resolve) => {
    const done = vscode.tasks.onDidEndTask((event) => { if (event.execution === execution) { done.dispose(); resolve(); } });
  });

  it('fails on a mod no source holds, and a task that depends on it does not run', async () => {
    const exitCodes: (number | undefined)[] = [];
    const listener = vscode.tasks.onDidEndTaskProcess((event) => { exitCodes.push(event.exitCode); });

    const chain = await vscode.tasks.executeTask(await labelled('After the build'));
    await ended(chain);
    const later = await vscode.tasks.executeTask(await labelled('Workspace step'));
    await ended(later);
    listener.dispose();

    assert.deepStrictEqual(
      [exitCodes.slice(0, 1), existsSync(path.join(root(), 'chain', 'ran.txt')), existsSync(path.join(root(), 'ran.txt'))],
      [[1], false, true],
    );
  });
});
