import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { clientHoldingNothing, pluginsOf, pluginsOver } from './pluginsOver';
import { present } from '../../ports/present';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { holdsLoadOrder, holdsNoLoadOrder } from '../../client/test/says';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled as until } from '../../test/eventually';

const STOPPED = 'mEdit stopped. Reload the window to start it again.';
const FILLING = { done: 1, total: 3, version: 1, settled: false };
const PLUGINS = ['A.esp', 'B.esp'].map((name) => ({ name, origin: 'ModA' }));
const READY = '$(check) mEdit: Ready (2 plugins)';

const theItem = () => present(host.statusBarItems[0], 'the one status bar item');
const reportsOf = (reporters: ReadonlyMap<string, { reports: readonly object[] }>) => [...reporters].flatMap(([tag, { reports }]) => reports.map((report) => ({ tag, ...report })));

function statusBar(status: InMemoryMEditClient['status'] = 'running') {
  const client = clientHoldingNothing();
  client.setStatus(status);
  client.setQueryAnswer('getPlugins', PLUGINS.map((plugin) => pluginMetadataFixture(plugin)));
  client.setQueryAnswer('getPluginsIndexing', []);
  const made = pluginsOver({
    client, value: instanceValueFixture({ plugins: pluginsOf(PLUGINS.map(({ name }) => name)) }),
  });
  const ready = async () => {
    holdsLoadOrder(client, { indexed: PLUGINS });
    await until(() => { expect(theItem().text).toBe(READY); });
  };
  return { ...made, ready };
}

describe('the status bar, one item saying what mEdit is doing', () => {
  it('shows mEdit\'s state from the start', () => {
    statusBar('stopped');

    expect(host.statusBarItems.map(({ text, shown }) => [text, shown])).toEqual([['$(circle-slash) mEdit: Stopped', true]]);
  });

  it.each([
    ['starting', '$(loading~spin) mEdit: Starting…'],
    ['running', '$(plug) mEdit: Running'],
    ['disconnected', '$(error) mEdit: Disconnected'],
    ['stopped', '$(circle-slash) mEdit: Stopped'],
  ] as const)('says %s on every change to it', (status, text) => {
    const { client } = statusBar();

    client.setStatus(status);

    expect(theItem().text).toBe(text);
  });

  it('says Ready once the snapshot is indexed, counting the active plugins', async () => {
    await statusBar().ready();
  });

  it('names a fill with its count, over an earlier Ready', async () => {
    const { client, ready } = statusBar();
    await ready();

    client.setProgress(FILLING);

    await until(() => { expect(theItem().text).toBe('$(sync~spin) mEdit: Indexing (1 of 3 plugins)'); });
  });

  it.each([
    ['before the snapshot is indexed', () => Promise.resolve(), ['mEdit is Running']],
    ['once it is indexed', (made: ReturnType<typeof statusBar>) => made.ready(), []],
    ['during a first index', (made: ReturnType<typeof statusBar>) => { made.client.setProgress(FILLING); return Promise.resolve(); }, ['mEdit is Indexing (1 of 3 plugins)']],
    ['during a reconcile after Ready', async (made: ReturnType<typeof statusBar>) => { await made.ready(); made.client.setProgress(FILLING); }, ['mEdit is Indexing (1 of 3 plugins)']],
  ] as const)('tells the agent the item\'s words unless it says Ready: %s', async (_case, arrange, lines) => {
    const made = statusBar();

    await arrange(made);

    expect(made.plugins.standing.mEdit()).toEqual(lines);
  });

  it.each([
    ['refused', () => (client: InMemoryMEditClient) => { client.setProgress({ ...FILLING, refusal: { kind: 'failed', message: 'bad' } }); }],
    ['dropped', () => holdsNoLoadOrder],
  ] as const)('gives the item and the agent mEdit\'s own state once the load order is %s, over an earlier Ready', async (_case, drop) => {
    const made = statusBar();
    await made.ready();

    drop()(made.client);

    await until(() => { expect([theItem().text, made.plugins.standing.mEdit()]).toEqual(['$(plug) mEdit: Running', ['mEdit is Running']]); });
  });

  it('does nothing on a click', () => {
    statusBar();

    expect(theItem().command).toBeUndefined();
  });

  it('is gone once disposed, and hears no further change', () => {
    const { client, plugins } = statusBar();

    plugins.dispose();
    client.setStatus('disconnected');

    expect([theItem().disposed, theItem().text]).toEqual([true, '$(plug) mEdit: Running']);
  });
});

describe('mEdit stopping', () => {
  it.each([
    ['a launch that left it stopped', () => Promise.resolve(), [{ tag: 'enterEditing', severity: 'error', message: STOPPED, detail: undefined }]],
    ['a launch that threw, with its reason', () => Promise.reject(new Error('no port')), [{ tag: 'launch', severity: 'error', message: STOPPED, detail: 'no port' }]],
    ['a launch that came up, not at all', (client: InMemoryMEditClient) => { client.setStatus('running'); return Promise.resolve(); }, []],
  ] as const)('reports %s, once', async (_case, start, expected) => {
    const { client, reporters } = statusBar('stopped');
    client.answerStart(() => start(client));

    await client.start();
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(reportsOf(reporters)).toEqual(expected);
  });

  it('is reported as stopped under its own report when mEdit exits', async () => {
    const { client, reporter } = statusBar();
    const exited = new Promise<void>((resolve) => { client.onExit(resolve); });

    client.crashed();
    await exited;

    expect(reporter('mEditExit').reports).toEqual([{ severity: 'error', message: STOPPED, detail: undefined }]);
  });

  it('is not reported once disposed', async () => {
    const { client, plugins, reporter } = statusBar();
    plugins.dispose();
    const exited = new Promise<void>((resolve) => { client.onExit(resolve); });

    client.crashed();
    await exited;

    expect(reporter('mEditExit').reports).toEqual([]);
  });
});
