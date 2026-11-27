import { describe, it, expect, vi, onTestFinished } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { indexedOver } from './pluginsOver';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { RefusedWrite, surfaceManagerRunning } from '../../drivingLib/writingGesture';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { recordingReporter } from '../../test/surfacingDoubles';
import { aWriteInFlight } from '../../test/writeInFlight';

const MOVE = 'modbench.plugin.move';
const A = { name: 'A.esp', origin: 'ModA' };
const LOSING_END = { kind: 'losingEnd' } as const;
const WINNING_END = { kind: 'winningEnd' } as const;
const REFUSED = '"A.esp" is a master of "B.esp", so it must load before it.';
const moved = (plugin: string, toIndex: number) => [{ verb: 'changePluginOrderOverProvided', profile: 'Default', changes: [{ kind: 'move', plugins: [plugin], toIndex }] }];
const mastersOfB = { getPlugins: () => Promise.resolve([pluginMetadataFixture({ name: 'A.esp' }), pluginMetadataFixture({ name: 'B.esp', masters: ['A.esp'] }), pluginMetadataFixture({ name: 'C.esp' })]) };
const indexing = { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) };

async function moving(masters: typeof indexing | typeof mastersOfB = indexing) {
  const made = await indexedOver(['A.esp', 'B.esp', 'C.esp'], {
    commandsClient: masters, value: { pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }] },
  });
  const own = () => made.reporter('pluginListTree.move').reports;
  return { ...made, own, move: (...args: unknown[]) => host.run(MOVE, ...args), rowsOfA: () => [made.row('A.esp'), [made.row('A.esp')]] };
}

describe('modbench.plugin.move, asked while a write is in flight', () => {
  it('tells the user once, as a refusal and no failure', async () => {
    const { fake, own, move, rowsOfA } = await moving();
    const { told } = aWriteInFlight();

    await move(...rowsOfA(), WINNING_END);

    expect({ calls: fake.calls, own: own(), told: told.reports.map(({ message }) => message) }).toEqual({
      calls: [], own: [], told: ['modbench.plugin.move did not start: modbench.test.held is still writing.'],
    });
  });

  it('goes back to the agent as the refusal', async () => {
    const { move } = await moving();
    aWriteInFlight();

    await expect(move(new AgentCall([{ kind: 'plugin', plugin: A }], { drop: WINNING_END }))).rejects.toBeInstanceOf(RefusedWrite);
  });
});

describe('modbench.plugin.move, while the mod manager is running', () => {
  it('warns the user, as a notification, after the move landed', async () => {
    const { move, rowsOfA } = await moving();
    const told = recordingReporter();
    const surface = surfaceManagerRunning({ reporter: told, running: () => Promise.resolve({ kind: 'running' }), message: () => 'MO2 is running.' });
    onTestFinished(() => { surface.dispose(); });

    await move(...rowsOfA(), WINNING_END);

    expect(told.reports.map(({ severity, message }) => ({ severity, message }))).toEqual([{ severity: 'warning', message: 'MO2 is running.' }]);
  });
});

describe('modbench.plugin.move', () => {
  it('hands the adapter the move to the target and ends on the read after it, under the Plugins view\'s progress', async () => {
    const { fake, move, rowsOfA } = await moving();
    host.progress.length = 0;

    await move(...rowsOfA(), WINNING_END);

    expect([fake.calls, host.progress]).toEqual([moved('A.esp', 2), ['opens on modbench.pluginListTree', 'closes']]);
  });

  it('takes the view\'s selection when no plugin is named, leaving out a row that is not a plugin line', async () => {
    const { fake, own, move, row, view } = await moving();
    view().selectRows([row('C.esp'), row('Fallout4.esm', 'Data/')]);

    await move(undefined, undefined, LOSING_END);

    expect([own(), fake.calls]).toEqual([[], moved('C.esp', 0)]);
  });

  it.each([
    ['with no target given, lands the block on the place picked', 'C.esp', undefined, moved('A.esp', 1)],
    ['asks for the place when the target given is not one', 'Bottom of the view', { kind: 'before' }, moved('A.esp', 2)],
  ])('%s', async (_case, picked, target, calls) => {
    const { fake, own, move, rowsOfA } = await moving();
    host.picks(() => picked);

    await move(...rowsOfA(), target);

    expect([own(), fake.calls]).toEqual([[], calls]);
  });

  it('moves nothing and says nothing when the pick is dismissed', async () => {
    const { fake, own, move, rowsOfA } = await moving();
    host.progress.length = 0;

    await move(...rowsOfA());

    expect([fake.calls, own(), host.progress]).toEqual([[], [], []]);
  });

  it('says why a move is refused by the plugin-order rules, naming both plugins', async () => {
    const { fake, own, move, rowsOfA } = await moving(mastersOfB);

    await move(...rowsOfA(), WINNING_END);

    expect([own(), fake.calls]).toEqual([[{ severity: 'error', message: 'Could not move plugins.', detail: REFUSED }], []]);
  });
});

describe('modbench.plugin.move, called by the agent', () => {
  it('moves the plugins given to the drop given, never the selection, picking and reporting nothing, and answers the outcome', async () => {
    const { fake, own, move, row, view } = await moving();
    view().selectRows([row('C.esp')]);

    const answered = await move(new AgentCall([{ kind: 'plugin', plugin: A }], { drop: LOSING_END }));

    expect([fake.calls, answered, own(), host.quickPicks]).toEqual([moved('A.esp', 0), { applied: true, outcome: { landed: [A], refused: [] } }, [], []]);
  });

  it('answers a refusal by the plugin-order rules, reporting nothing', async () => {
    const { fake, own, move } = await moving(mastersOfB);

    const answered = await move(new AgentCall([{ kind: 'plugin', plugin: A }], { drop: WINNING_END }));

    expect([answered, fake.calls, own()]).toEqual([{ applied: false, refusal: 'Could not move plugins.', detail: REFUSED }, [], []]);
  });

  it('refuses an Argument that is not a plugin, writing nothing', async () => {
    const { fake, move } = await moving();

    await expect(move(new AgentCall([{ kind: 'mod', name: 'ModA' }], { drop: LOSING_END }))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});
