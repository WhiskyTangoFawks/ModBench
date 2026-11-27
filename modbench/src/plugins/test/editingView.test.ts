import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { clientHoldingNothing, pluginsOver } from './pluginsOver';
import type { PutLoadOrderResult } from '../../instanceCommands/loadOrder';
import type { PluginMetadata } from '../../client';
import { holdsLoadOrder } from '../../client/test/says';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

type Sent = Extract<PutLoadOrderResult, { sent: true }>;
type Outcome = Sent['outcome'];

const SNAPSHOT: Sent['snapshot'] = {
  plugins: [], active: [], loadedWithNoLine: [], archives: [], listedArchives: [], stringsFiles: [], places: [],
  dataFolder: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4', stringsLanguage: 'English',
};

const sent = (outcome: Outcome): PutLoadOrderResult => ({ sent: true, snapshot: SNAPSHOT, outcome });
const refused = (refusal: string): PutLoadOrderResult => ({ sent: false, refusal });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function editing() {
  const made = pluginsOver({ value: instanceValueFixture({ gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' } }) });
  return { ...made, onPut: made.shown.editingInPluginsView.onPut, putReports: () => made.reporter('loadOrder').reports.map(({ message }) => message) };
}

describe('the entry shown', () => {
  it('runs under the progress, with the log revealed and the launch said', async () => {
    const { shown, view, revealed, output } = editing();
    const ran: unknown[] = [];

    await shown.editingInPluginsView.around(() => { ran.push([view().message, revealed(), output]); return Promise.resolve(); });

    expect(ran).toEqual([['Starting backend…', 1, ['[toolbox] entering editing: starting backend']]]);
  });
});

describe('a load order the loader refused, shown', () => {
  it("says the refusal in the Plugins view's message line and in the Output", async () => {
    const { onPut, view, output } = editing();

    await onPut(refused('a.esp is provided by the mod ModA, which has no mod folder'));

    expect(view().message).toBe('The load order is not sent: a.esp is provided by the mod ModA, which has no mod folder.');
    expect(output).toEqual(['[loadOrder] put load order failed: a.esp is provided by the mod ModA, which has no mod folder']);
  });

  it('clears the message line once a snapshot is sent', async () => {
    const { onPut, view } = editing();
    await onPut(refused('a.esp has no mod folder'));

    await onPut(sent({ outcome: 'abandoned' }));

    expect(view().message).toBeUndefined();
  });

  it('leaves the line alone for a game folder not found, which the views already tell', async () => {
    const { onPut, view } = editing();
    await onPut(refused('a.esp has no mod folder'));

    await onPut({ sent: false });

    expect(view().message).toBe('The load order is not sent: a.esp has no mod folder.');
  });
});

describe("a put's own outcome shown", () => {
  it("reports a failed send's message verbatim, as the put's", async () => {
    const { onPut, putReports } = editing();

    await onPut(sent({ outcome: 'failed', message: 'Failed to send the load order — bad dir' }));

    expect(putReports()).toEqual(['Failed to send the load order — bad dir']);
  });

  it('says nothing for an abandoned send, which owns no view', async () => {
    const { onPut, putReports, output } = editing();

    await onPut(sent({ outcome: 'abandoned' }));

    expect([putReports(), output]).toEqual([[], ['[toolbox] handed mEdit the load order snapshot (0 plugins, 0 active)']]);
  });

  it("hands an applied send's status to the views and is done once they hold it", async () => {
    const client = clientHoldingNothing();
    let answer!: (plugins: PluginMetadata[]) => void;
    const made = pluginsOver({ client });
    const held = new Promise<PluginMetadata[]>((resolve) => { answer = resolve; });
    client.setQueryAnswerOnce('getPlugins', held);
    client.setQueryAnswerOnce('getPlugins', held);
    holdsLoadOrder(client, { version: 7, total: 1 });
    let done = false;

    const putting = made.shown.editingInPluginsView.onPut(sent({ outcome: 'applied', version: 7 })).then(() => { done = true; });
    await settle();
    const before = done;
    answer([]);
    await putting;

    expect([before, made.plugins.standing.mEdit(), made.reporter('loadOrder').reports]).toEqual([false, [], []]);
  });

  it('shows nothing when no snapshot was sent', async () => {
    const { onPut, putReports, output, view } = editing();

    await onPut({ sent: false });

    expect([putReports(), output, view().message]).toEqual([[], [], undefined]);
  });
});
