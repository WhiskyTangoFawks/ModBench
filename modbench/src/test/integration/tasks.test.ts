import * as assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'mocha';
import { present } from '../../ports/present';
import { stepTasks } from '../../sourceCommands/steps';
import { hostTasks } from '../../tasks';

const TEST_PORT = present(process.env.MODBENCH_TEST_PORT, 'the port .vscode-test.mjs hands the run');

describe('a step\'s user task, as .vscode-test.mjs writes it: a script that records its arguments and MEDIT_PORT in its folder and exits with the last', () => {
  const tasks = stepTasks(hostTasks);
  const folders: string[] = [];
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

  it('is among the labels of this machine\'s user tasks, and a workspace task is not', async () => {
    const labels = await tasks.labels();

    assert.deepStrictEqual(['Process step', 'Shell step', 'Workspace step'].map((label) => labels.includes(label)), [true, true, false], `the labels were ${labels.join(', ')}`);
  });

  for (const label of ['Process step', 'Shell step']) {
    it(`${label}: the user task runs in the folder with the step's arguments after its own and medit's port, and answers its exit code`, async () => {
      const folder = mkdtempSync(path.join(os.tmpdir(), 'modbench-step-'));
      folders.push(folder);

      const why = await tasks.whyStepsFailed([{ task: label, args: ['textures', '3'] }], folder);

      assert.deepStrictEqual([why, readFileSync(path.join(folder, 'ran.txt'), 'utf8')], [`step '${label}' exited with code 3`, `textures 3\n${TEST_PORT}`]);
    });
  }
});
