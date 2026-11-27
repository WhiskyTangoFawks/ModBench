import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host, TreeItemCheckboxState } from './vscodeHost';
import { indexedOver } from './pluginsOver';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { aWriteInFlight } from '../../test/writeInFlight';

const REFUSED: InstanceAnswers = { refusals: refusing('changePluginOrder', 'ENOENT: no plugins.txt') };
const ENDS_ON_THE_READ = ['opens on modbench.pluginListTree', 'closes'];
const { Checked, Unchecked } = TreeItemCheckboxState;
const enabling = (...pairs: [string, boolean][]) =>
  [{ verb: 'changePluginOrder', profile: 'Default', changes: pairs.map(([plugin, enabled]) => ({ kind: 'enable', plugin, enabled })) }];

async function participating(answers: InstanceAnswers = {}) {
  const made = await indexedOver(['Alpha.esp', 'Beta.esp', 'Gone.esp'], {
    answers, reading: { pluginOrder: [{ name: 'Alpha.esp', enabled: false }, { name: 'Beta.esp', enabled: true }] },
    value: { pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }] },
  });
  host.progress.length = 0;
  const redrawn: unknown[] = [];
  made.view().treeDataProvider.onDidChangeTreeData?.((rows) => { redrawn.push(rows); });
  return { ...made, redrawn, own: (gesture: string) => made.reporter(`pluginListTree.${gesture}`).reports };
}

describe('modbench.plugin.enable / modbench.plugin.disable: the whole selection, one command per direction', () => {
  it.each([['enables', 'modbench.plugin.enable', true], ['disables', 'modbench.plugin.disable', false]] as const)(
    '%s every selected plugin, whatever its own current state', async (_verb, command, enabled) => {
      const { fake, row } = await participating();

      await host.run(command, row('Alpha.esp'), [row('Alpha.esp'), row('Beta.esp')]);

      expect(fake.calls).toEqual(enabling(['Alpha.esp', enabled], ['Beta.esp', enabled]));
    });

  it('drops a locked row from the selection it writes, and says nothing when the rest lands', async () => {
    const { fake, own, row } = await participating();

    await host.run('modbench.plugin.enable', row('Alpha.esp'), [row('Fallout4.esm', 'Data/'), row('Alpha.esp')]);

    expect([fake.calls, own('enableDisable')]).toEqual([enabling(['Alpha.esp', true]), []]);
  });

  it('reports a gone plugin by name, once, while the rest land', async () => {
    const { fake, own, row } = await participating();

    await host.run('modbench.plugin.enable', row('Alpha.esp'), [row('Alpha.esp'), row('Gone.esp')]);

    expect([fake.calls, own('enableDisable')]).toEqual([enabling(['Alpha.esp', true]), [
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"Gone.esp" (Plugin not found in plugins.txt: Gone.esp)' },
    ]]);
  });

  it('reports the whole selection refused, once, when the adapter refuses the change', async () => {
    const { own, row } = await participating(REFUSED);

    await host.run('modbench.plugin.disable', row('Alpha.esp'));

    expect(own('enableDisable')).toMatchObject([{ severity: 'error', message: 'Failed to disable plugins.' }]);
  });

  it('shows the progress bar from the key until the read after the write lands', async () => {
    const { row } = await participating();

    await host.run('modbench.plugin.enable', row('Alpha.esp'));

    expect(host.progress).toEqual(ENDS_ON_THE_READ);
  });
});

describe('modbench.plugin.enable / modbench.plugin.disable, called by the agent', () => {
  const given = (...names: string[]) => new AgentCall(names.map((name) => ({ kind: 'plugin' as const, plugin: { name, origin: 'ModA' } })), {});

  it.each([['enables', 'modbench.plugin.enable', true], ['disables', 'modbench.plugin.disable', false]] as const)(
    '%s the plugins given, never the selection, and answers the outcome by address, reporting nothing', async (_verb, command, enabled) => {
      const { fake, own, row, view } = await participating();
      view().selectRows([row('Alpha.esp')]);

      const answered = await host.run(command, given('Beta.esp', 'Gone.esp'));

      expect([fake.calls, answered, own('enableDisable')]).toEqual([enabling(['Beta.esp', enabled]), {
        applied: true,
        outcome: { landed: [{ name: 'Beta.esp', origin: 'ModA' }], refused: [{ item: { name: 'Gone.esp', origin: 'ModA' }, reason: 'Plugin not found in plugins.txt: Gone.esp' }] },
      }, []]);
    });

  it('refuses an Argument that is not a plugin, writing nothing', async () => {
    const { fake } = await participating();

    await expect(host.run('modbench.plugin.enable', new AgentCall([{ kind: 'mod', name: 'ModA' }], {}))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});

describe('a plugin row\'s check box', () => {
  it('hands the adapter the enable of the plugin, says nothing on a full landing, and shows the progress bar until the read lands', async () => {
    const { fake, own, row } = await participating();

    await host.check([[row('Alpha.esp'), Checked]]);

    expect([fake.calls, own('checkbox'), host.progress]).toEqual([enabling(['Alpha.esp', true]), [], ENDS_ON_THE_READ]);
  });

  it('lands the boxes checked and the boxes unchecked as two writes, each named by its own direction', async () => {
    const { fake, row } = await participating();

    await host.check([[row('Alpha.esp'), Checked], [row('Beta.esp'), Unchecked]]);

    expect(fake.calls).toEqual([...enabling(['Alpha.esp', true]), ...enabling(['Beta.esp', false])]);
  });

  it('restores every row it clicked once its writes end, though they failed, naming the failure of each direction by its own (common.md, A gesture that writes, story 2)', async () => {
    const { own, row, redrawn, item } = await participating(REFUSED);
    (await item(row('Beta.esp'))).checkboxState = Unchecked;

    await host.check([[row('Alpha.esp'), Checked], [row('Beta.esp'), Unchecked]]);

    expect(redrawn).toEqual(expect.arrayContaining([row('Alpha.esp'), row('Beta.esp')]));
    expect((await item(row('Beta.esp'))).checkboxState).toBe(Checked);
    expect(own('checkbox')).toMatchObject([{ severity: 'error', message: 'Failed to enable plugins.' }, { severity: 'error', message: 'Failed to disable plugins.' }]);
  });

  it('is refused while a write is in flight: the user is told once, its row is restored, and nothing is written', async () => {
    const { fake, own, row, redrawn } = await participating();
    const { told } = aWriteInFlight();

    await host.check([[row('Alpha.esp'), Checked]]);

    expect({ calls: fake.calls, own: own('checkbox'), told: told.reports.map(({ message }) => message) }).toEqual({
      calls: [], own: [], told: ['modbench.plugin.enable did not start: modbench.test.held is still writing.'],
    });
    expect(redrawn).toContain(row('Alpha.esp'));
  });

  it('is told once when a mixed batch is refused while a write is in flight', async () => {
    const { fake, row } = await participating();
    const { told } = aWriteInFlight();

    await host.check([[row('Alpha.esp'), Checked], [row('Beta.esp'), Unchecked]]);

    expect({ calls: fake.calls, told: told.reports.map(({ message }) => message) }).toEqual({
      calls: [], told: ['modbench.plugin.enable did not start: modbench.test.held is still writing. Nothing was enabled or disabled.'],
    });
  });

  it('ignores a row beneath a plugin, writing nothing and opening no progress', async () => {
    const { client, fake, row, rows } = await participating();
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'ARMO' })]);
    const [group] = await rows(row('Alpha.esp'));

    await host.check([[group, Checked]]);

    expect([fake.calls, host.progress]).toEqual([[], []]);
  });
});
