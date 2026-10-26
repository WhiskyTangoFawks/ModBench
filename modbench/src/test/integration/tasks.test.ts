import * as assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'mocha';
import { tasks } from '../../drivingLib/tasks';

describe('a step\'s user task, as .vscode-test.mjs writes it: a script that records its arguments in its folder and exits with the last', () => {
  const folders: string[] = [];
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

  it('is among the labels of the tasks this machine has', async () => {
    const labels = await tasks.labels();

    assert.ok(labels.includes('Process step') && labels.includes('Shell step'), `the labels were ${labels.join(', ')}`);
  });

  for (const label of ['Process step', 'Shell step']) {
    it(`${label}: runs in the folder with the step's arguments after its own, and answers its exit code`, async () => {
      const folder = mkdtempSync(path.join(os.tmpdir(), 'modbench-step-'));
      folders.push(folder);

      const ended = await tasks.run(label, ['textures', '3'], folder);

      assert.deepStrictEqual([ended, readFileSync(path.join(folder, 'ran.txt'), 'utf8')], [3, 'textures 3']);
    });
  }

  it('answers why a label this machine has no task for did not run', async () => {
    assert.strictEqual(await tasks.run('No such task', [], os.tmpdir()), 'this machine has no task \'No such task\'');
  });
});
