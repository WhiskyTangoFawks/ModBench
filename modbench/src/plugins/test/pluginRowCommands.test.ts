import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { clientHoldingNothing, pluginsOver } from './pluginsOver';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { gestureName, phrase } from '../../ports/phrase';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { scriptedDialog } from '../../test/surfacingDoubles';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import type { PluginAddress, SourceModIn } from '../../client';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const FIRST = { name: 'First.esp', origin: 'ModA' };
const SECOND = { name: 'Second.esp', origin: 'ModA' };
const MALFORMED = { name: 'Malformed.esp', origin: 'ModA' };
const SELECTED = { name: 'Selected.esp', origin: 'ModA' };

const beneath = (...plugin: ('None' | 'Modified' | 'Added')[]) => ({ plugin, recordTypes: {}, records: {} });
const clean = beneath('None');
const changedSource = beneath('Modified');

type Over = Parameters<typeof pluginsOver>[0];

async function gesturing(answers: readonly (string | undefined)[], over: Over & { holdsRepository?: boolean } = {}) {
  const { holdsRepository = false, ...rest } = over;
  const client = rest.client ?? clientHoldingNothing();
  const ask = scriptedDialog(...answers);
  const made = pluginsOver({
    client, ask, ...rest,
    value: instanceValueFixture({
      holdsRepository, mods: [{ kind: 'mod', name: 'ModA', enabled: true }], listedSourceMods: new Set(['ModA']),
      plugins: [FIRST, SECOND, MALFORMED, SELECTED].map(({ name, origin }, line) => ({ name, origin, path: `/m/${name}`, line, enabled: true, winning: true })),
    }),
  });
  const row = await made.pluginRows();
  const rowOf = ({ name, origin }: PluginAddress) => row(name, origin);
  return { ...made, client, ask, rowOf, select: (rows: readonly unknown[]) => { made.view().selectRows(rows); } };
}

describe('modbench.plugin.decompile', () => {
  const decompileCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'decompile').map((c) => c.args);

  async function decompiling(client: InMemoryMEditClient, answer: string | undefined) {
    const made = await gesturing([answer], { client });
    return { ...made, reporter: made.reporter('plugin.decompile'), run: (...args: unknown[]) => host.run('modbench.plugin.decompile', ...args) };
  }

  const landing = (client: InMemoryMEditClient) => {
    client.setCommandHandler('decompile', (plugins, force) => {
      host.progress.push(`decompile ${plugins.map(({ name }) => name).join(', ')}${force ? ' forced' : ''}`);
      return Promise.resolve({ landed: plugins, refused: [] });
    });
  };

  it('on a plugin row whose source git holds, decompiles it unforced asking nothing, the view\'s progress bar closing once the Instance loader has read again, and lands once', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    landing(client);
    const { run, reporter, ask, rowOf } = await decompiling(client, 'Decompile');

    await run(rowOf(SECOND));

    expect(ask.asked).toEqual([]);
    expect(host.progress).toEqual(['opens on modbench.pluginListTree', 'decompile Second.esp', 'closes']);
    expect(reporter.landings).toEqual(['Decompiled "Second.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  it('on a plugin row whose source has changes git does not hold, asks naming it before any write, the progress bar closed while it waits', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', changedSource);
    landing(client);
    const { run, reporter, ask, rowOf } = await decompiling(client, 'Decompile');

    await run(rowOf(SECOND));

    expect(ask.asked).toEqual([{
      message: 'Decompile "Second.esp" in ModA? It replaces changes to its source that git does not hold.',
      detail: undefined,
      buttons: ['Decompile'],
    }]);
    expect(host.progress).toEqual([
      'opens on modbench.pluginListTree', 'closes',
      'opens on modbench.pluginListTree', 'decompile Second.esp forced', 'closes',
    ]);
    expect(reporter.landings).toEqual(['Decompiled "Second.esp".']);
  });

  it('on a selection, asks once naming only the plugins with such changes, then sends them forced and the rest unforced', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', changedSource);
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', clean);
    client.setCommandHandler('decompile', (plugins) => Promise.resolve({ landed: plugins, refused: [] }));
    const { run, reporter, ask, rowOf } = await decompiling(client, 'Decompile');
    const rows = [rowOf(FIRST), rowOf(SECOND)];

    await run(rows[0], rows);

    expect(ask.asked).toEqual([{
      message: 'Decompile "First.esp" in ModA? It replaces changes to its source that git does not hold.',
      detail: undefined,
      buttons: ['Decompile'],
    }]);
    expect(decompileCalls(client)).toEqual([[[FIRST], true], [[SECOND], false]]);
    expect(reporter.landings).toEqual(['Decompiled 2 plugins.']);
  });

  it('names several plugins with such changes in the one prompt\'s detail', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', changedSource);
    client.setCommandHandler('decompile', (plugins) => Promise.resolve({ landed: plugins, refused: [] }));
    const { run, ask, rowOf } = await decompiling(client, 'Decompile');
    const rows = [rowOf(FIRST), rowOf(SECOND)];

    await run(rows[0], rows);

    expect(ask.asked).toEqual([{
      message: 'Decompile 2 plugins? They replace changes to their source that git does not hold.',
      detail: 'First.esp (ModA)\nSecond.esp (ModA)',
      buttons: ['Decompile'],
    }]);
    expect(decompileCalls(client)).toEqual([[[FIRST, SECOND], true]]);
  });

  it('writes nothing and says nothing when the confirmation is dismissed', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', changedSource);
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', clean);
    const { run, reporter, ask, rowOf } = await decompiling(client, undefined);
    const rows = [rowOf(FIRST), rowOf(SECOND)];

    await run(rows[0], rows);

    expect(ask.asked).toHaveLength(1);
    expect(decompileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports mEdit\'s working-tree refusal as it comes back, without a second ask, when the tree changed after the read', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    const refusal = 'First.esp\'s source has working-tree changes that decompile would replace.';
    client.setCommandResult('decompile', { landed: [], refused: [{ item: FIRST, reason: refusal, refusal: 'WorkingTreeChanges' }] });
    const { run, reporter, ask, rowOf } = await decompiling(client, 'Decompile');

    await run(rowOf(FIRST));

    expect(ask.asked).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not decompile "First.esp".', detail: `"First.esp (ModA)" (${refusal})` }]);
  });

  it('sends unforced for a plugin whose states cannot be read, leaving mEdit\'s guard to refuse', async () => {
    const client = clientHoldingNothing();
    client.setQueryFailure('getWorkingTreeStatesBeneath', { failed: 'unreachable' });
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { run, ask, rowOf } = await decompiling(client, 'Decompile');

    await run(rowOf(SECOND));

    expect(ask.asked).toEqual([]);
    expect(decompileCalls(client)).toEqual([[[SECOND], false]]);
  });

  it('reports what the forced send landed and the unforced send was refused when the unforced send is refused whole', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', changedSource);
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', clean);
    client.setCommandHandler('decompile', (plugins, force) => Promise.resolve(force
      ? { landed: plugins, refused: [] }
      : { refused: true as const, message: 'git went away.' }));
    const { run, reporter, rowOf } = await decompiling(client, 'Decompile');
    const rows = [rowOf(FIRST), rowOf(SECOND)];

    await run(rows[0], rows);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not decompile 1 of 2 plugins.', detail: '"Second.esp (ModA)" (git went away.)' },
    ]);
  });

  it('refuses the whole selection once, writing nothing further, when the forced send is refused whole', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', changedSource);
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', clean);
    client.setCommandResult('decompile', { refused: true, message: 'git was not found on PATH.' });
    const { run, reporter, rowOf } = await decompiling(client, 'Decompile');
    const rows = [rowOf(FIRST), rowOf(SECOND)];

    await run(rows[0], rows);

    expect(decompileCalls(client)).toEqual([[[FIRST], true]]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'git was not found on PATH.', detail: undefined }]);
  });

  it('names each refused plugin and why in one notification while the rest land', async () => {
    const client = clientHoldingNothing();
    const refusal = 'First.esp does not round-trip through its own source.';
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    client.setCommandResult('decompile', { landed: [SECOND], refused: [{ item: FIRST, reason: refusal, refusal: 'RoundTripFailed' }] });
    const { run, reporter, rowOf } = await decompiling(client, 'Decompile');
    const rows = [rowOf(FIRST), rowOf(SECOND)];

    await run(rows[0], rows);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not decompile 1 of 2 plugins.', detail: `"First.esp (ModA)" (${refusal})` },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('from a plugin source unreadable entry\'s link in the Problems panel, decompiles the plugin it names, not the selection', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { run, rowOf, select } = await decompiling(client, 'Decompile');
    select([rowOf(FIRST)]);

    await run(SECOND);

    expect(decompileCalls(client)).toEqual([[[SECOND], false]]);
  });

  it('reports a refusal of the whole selection once, and lands nothing', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    client.setCommandResult('decompile', { refused: true, message: 'Could not decompile 1 plugin — git was not found on PATH.' });
    const { run, reporter, rowOf } = await decompiling(client, 'Decompile');

    await run(rowOf(SECOND));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not decompile 1 plugin — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });
});

describe('modbench.plugin.decompile, called by the agent', () => {
  const calling = (...plugins: { name: string; origin: string }[]) => new AgentCall(plugins.map((plugin) => ({ kind: 'plugin' as const, plugin })), {});

  async function asked(client: InMemoryMEditClient) {
    const made = await gesturing(['Decompile'], { client });
    made.select([made.rowOf(SELECTED)]);
    return { ...made, reporter: made.reporter('plugin.decompile'), run: (...args: unknown[]) => host.run('modbench.plugin.decompile', ...args) };
  }

  it('decompiles the plugins given, never the selection, asking nothing and reporting nothing, and answers the outcome', async () => {
    const client = clientHoldingNothing();
    const outcome = { landed: [SECOND], refused: [{ item: FIRST, reason: 'First.esp does not round-trip through its own source.', refusal: 'RoundTripFailed' as const }] };
    client.setCommandResult('decompile', outcome);
    const { run, reporter, ask } = await asked(client);

    const answered = await run(calling(FIRST, SECOND));

    expect(client.calls.filter((c) => c.method === 'decompile').map((c) => c.args)).toEqual([[[FIRST, SECOND], false]]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [SECOND], refused: [{ item: FIRST, reason: outcome.refused[0]?.reason }] } });
    expect(ask.asked).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('requests the decompile forced when its options say force', async () => {
    const client = clientHoldingNothing();
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { run } = await asked(client);

    await run(new AgentCall([{ kind: 'plugin', plugin: SECOND }], { force: true }));

    expect(client.calls.filter((c) => c.method === 'decompile').map((c) => c.args)).toEqual([[[SECOND], true]]);
  });

  const FACT = 'Second.esp cannot be decompiled.';
  describe.each([
    ['NotInSourceMod', phrase`${FACT} Run ${gestureName('modbench.mod.versionInGit', 'version in git')} on ${SECOND.origin}.`, 'Run version in git on ModA.'],
    ['MalformedRepairable', phrase`${FACT} Run ${gestureName('modbench.plugin.decompileAndRepair', 'decompile and repair')} on it.`, 'Run decompile and repair on it.'],
  ] as const)('a plugin refused as %s', (refusal, reason, remedy) => {
    const clientRefusing = () => {
      const client = clientHoldingNothing();
      client.setQueryAnswer('getWorkingTreeStatesBeneath', { plugin: ['None'], recordTypes: {}, records: {} });
      client.setCommandResult('decompile', { landed: [], refused: [{ item: SECOND, reason: FACT, refusal }] });
      return client;
    };

    it('tells the view the gesture that clears it', async () => {
      const { run, reporter, rowOf } = await asked(clientRefusing());

      await run(rowOf(SECOND));

      expect(reporter.reports).toEqual([{
        severity: 'error', message: 'Could not decompile "Second.esp".', detail: `"Second.esp (ModA)" (${FACT} ${remedy})`,
      }]);
    });

    it('names the gesture as data for the agent, which reads the tool that runs it', async () => {
      const answered = await (await asked(clientRefusing())).run(calling(SECOND));

      expect(answered).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: SECOND, reason }] } });
    });
  });

  it('answers the refusal of the whole selection', async () => {
    const client = clientHoldingNothing();
    client.setCommandResult('decompile', { refused: true, message: 'git was not found on PATH.' });
    const { run, reporter } = await asked(client);

    expect(await run(calling(SECOND))).toEqual({ applied: false, refusal: 'git was not found on PATH.' });
    expect(reporter.reports).toEqual([]);
  });

  it('refuses an Argument that is not a plugin, decompiling nothing', async () => {
    const client = clientHoldingNothing();
    const { run } = await asked(client);

    await expect(run(new AgentCall([{ kind: 'mod', name: 'ModA' }], {}))).rejects.toBeInstanceOf(Refusal);

    expect(client.calls.filter((c) => c.method === 'decompile')).toEqual([]);
  });
});

describe('modbench.plugin.decompileAndRepair', () => {
  interface Repairing {
    answers?: readonly (string | undefined)[];
    states?: readonly ReturnType<typeof beneath>[];
    holdsRepository?: boolean;
    outside?: readonly string[];
    outcome?: (plugins: readonly PluginAddress[]) => { landed: PluginAddress[]; refused: { item: PluginAddress; reason: string }[] };
    notesPerBatch?: string[][];
  }

  async function repairing({ answers = [], states = [], holdsRepository = false, outside = [], outcome, notesPerBatch = [] }: Repairing = {}) {
    const client = clientHoldingNothing();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    for (const state of states) client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', state);
    const repaired: { plugins: readonly PluginAddress[]; force: boolean; where?: SourceModIn }[] = [];
    const batches = [...notesPerBatch];
    const commands = {
      ...pluginCommandsWith(fakeInstanceAdapter().adapter),
      outsideSourceMods: () => Promise.resolve([...outside]),
      decompileAndRepair: (plugins: readonly PluginAddress[], force: boolean, where?: SourceModIn) => {
        host.progress.push(`decompile and repair${force ? ' forced' : ''}`);
        repaired.push(where === undefined ? { plugins, force } : { plugins, force, where });
        return Promise.resolve({ applied: true as const, outcome: outcome?.(plugins) ?? { landed: [...plugins], refused: [] }, notes: batches.shift() ?? [] });
      },
    };
    const made = await gesturing(answers, { client, commands, holdsRepository });
    return {
      ...made, repaired, unanswered: batches,
      reporter: made.reporter('plugin.decompileAndRepair'), run: (...args: unknown[]) => host.run('modbench.plugin.decompileAndRepair', ...args),
    };
  }

  it('on a plugin row whose source is held, repairs it unforced asking nothing, under the view\'s progress, and lands once', async () => {
    const { run, reporter, repaired, ask, rowOf } = await repairing();

    await run(rowOf(MALFORMED));

    expect(repaired).toEqual([{ plugins: [MALFORMED], force: false }]);
    expect(ask.asked).toEqual([]);
    expect(host.progress).toEqual(['opens on modbench.pluginListTree', 'decompile and repair', 'closes']);
    expect(reporter.landings).toEqual(['Decompiled and repaired "Malformed.esp".']);
  });

  it('on a plugin row whose source has working-tree changes, asks naming it before any write, then repairs it forced', async () => {
    const { run, repaired, ask, rowOf } = await repairing({ answers: ['Decompile and repair'], states: [changedSource] });

    await run(rowOf(MALFORMED));

    expect(ask.asked).toEqual([{
      message: 'Decompile and repair "Malformed.esp" in ModA? It replaces changes to its source that git does not hold.',
      detail: undefined,
      buttons: ['Decompile and repair'],
    }]);
    expect(repaired).toEqual([{ plugins: [MALFORMED], force: true }]);
  });

  it('from a Malformed entry\'s link in the Problems panel, repairs the plugin it names, not the selection', async () => {
    const { run, repaired, rowOf, select } = await repairing();
    select([rowOf(SELECTED)]);

    await run(MALFORMED);

    expect(repaired.map(({ plugins }) => plugins)).toEqual([[MALFORMED]]);
  });

  it('for the agent, repairs the plugins given, forced when its options say force, asking nothing and reporting nothing, and answers the outcome', async () => {
    const { run, reporter, repaired, ask, rowOf, select } = await repairing();
    select([rowOf(SELECTED)]);

    const answered = await run(new AgentCall([{ kind: 'plugin', plugin: MALFORMED }], { force: true }));

    expect(repaired).toEqual([{ plugins: [MALFORMED], force: true }]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [] } });
    expect(ask.asked).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('tells the user a plugin mEdit refused, naming why', async () => {
    const reason = 'Malformed.esp is not malformed.';
    const { run, reporter, rowOf } = await repairing({ outcome: () => ({ landed: [], refused: [{ item: MALFORMED, reason }] }) });

    await run(rowOf(MALFORMED));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not decompile and repair "Malformed.esp".', detail: `"Malformed.esp (ModA)" (${reason})` }]);
  });

  describe('what a downloaded file could not give', () => {
    it('warns of each note once, though both batches a replace confirmation makes answer it', async () => {
      const { run, reporter, unanswered, rowOf } = await repairing({
        answers: ['Decompile and repair'], states: [changedSource, clean], notesPerBatch: [['Pack.7z could not be read whole.'], ['Pack.7z could not be read whole.']],
      });
      const rows = [rowOf(MALFORMED), rowOf(SELECTED)];

      await run(rows[0], rows);

      expect(unanswered).toEqual([]);
      expect(reporter.reports).toContainEqual({ severity: 'warning', message: 'Decompile and repair:', detail: 'Pack.7z could not be read whole.' });
      expect(reporter.reports.filter(({ severity }) => severity === 'warning')).toHaveLength(1);
    });

    it('answers an agent the notes as partial failures, the shape version in git answers, and no notes', async () => {
      const { run } = await repairing({ notesPerBatch: [['Pack.7z could not be read whole.']] });

      const answered = await run(new AgentCall([{ kind: 'plugin', plugin: MALFORMED }], {}));

      expect(answered).toEqual({
        applied: true, outcome: { landed: [MALFORMED], refused: [] },
        partial: [{ message: 'Decompile and repair:', detail: 'Pack.7z could not be read whole.', severity: 'warning' }],
      });
    });
  });

  describe('where git holds a mod that is not a source mod', () => {
    const IN_THE_INSTANCE_REPOSITORY = 'A source mod in the instance repository';

    it('hands the one answer to both batches a replace confirmation makes', async () => {
      const { run, repaired, rowOf } = await repairing({
        answers: ['Decompile and repair'], states: [changedSource, clean], holdsRepository: true, outside: ['ModA'],
      });
      host.picks(() => IN_THE_INSTANCE_REPOSITORY);
      const rows = [rowOf(MALFORMED), rowOf(SELECTED)];

      await run(rows[0], rows);

      expect(host.quickPicks).toHaveLength(1);
      expect(repaired.map(({ force, where }) => [force, where])).toEqual([[true, 'InstanceRepository'], [false, 'InstanceRepository']]);
    });

    describe('for the agent', () => {
      const calling = (options: { where?: SourceModIn }) => new AgentCall([{ kind: 'plugin', plugin: MALFORMED }], options);

      it.each<SourceModIn>(['NewRepository', 'InstanceRepository'])('puts a mod that is not a source mod where its options say, %s', async (where) => {
        const { run, repaired } = await repairing({ outside: ['ModA'] });

        await run(calling({ where }));

        expect(repaired).toEqual([{ plugins: [MALFORMED], force: false, where }]);
      });

      it('refuses a request that leaves out where while a plugin\'s mod is not a source mod, naming the option, and repairs nothing', async () => {
        const { run, repaired } = await repairing({ outside: ['ModA'] });

        await expect(run(calling({}))).rejects.toThrow(/\bwhere\b/);

        expect(repaired).toEqual([]);
      });

      it('repairs without where when every plugin is in a source mod', async () => {
        const { run, repaired } = await repairing();

        await run(calling({}));

        expect(repaired).toEqual([{ plugins: [MALFORMED], force: false }]);
      });
    });

    it('asks nothing when every plugin is in a source mod', async () => {
      const { run, repaired, rowOf } = await repairing({ holdsRepository: true });

      await run(rowOf(MALFORMED));

      expect([host.quickPicks, repaired.length]).toEqual([[], 1]);
    });

    it('changes nothing when the pick is dismissed: no confirmation, no repair', async () => {
      const { run, repaired, ask, rowOf } = await repairing({
        answers: ['Decompile and repair'], states: [changedSource], holdsRepository: true, outside: ['ModA'],
      });

      await run(rowOf(MALFORMED));

      expect([repaired, ask.asked]).toEqual([[], []]);
    });
  });
});
