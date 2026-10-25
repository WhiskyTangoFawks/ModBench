import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeItem { text: string; command?: unknown; shown: boolean; disposed: boolean }

const h = vi.hoisted(() => ({ items: [] as FakeItem[] }));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createStatusBarItem: () => {
      const item = {
        text: '', shown: false, disposed: false,
        show() { item.shown = true; },
        dispose() { item.disposed = true; },
      };
      h.items.push(item);
      return item;
    },
  },
}));

import { createStatusBar } from '../statusBar';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { present } from '../../ports/present';
import type { Reporter } from '../../ports/reporter';
import { recordingReporter } from '../../test/surfacingDoubles';

const theItem = (): FakeItem => present(h.items[0], 'the one status bar item');

const STOPPED = 'mEdit stopped. Reload the window to start it again.';

interface Report { tag: string; severity: string; message: string; detail: string | undefined }
let reports: Report[] = [];
const reporterFor = (tag: string): Reporter => ({
  ...recordingReporter(),
  report: (severity, message, detail) => { reports.push({ tag, severity, message, detail }); },
});

beforeEach(() => { h.items.length = 0; reports = []; });

const launchedBy = (client: InMemoryMEditClient): Promise<unknown> =>
  new Promise((resolve) => { client.onLaunch(resolve); });

const exitOf = (client: InMemoryMEditClient): Promise<void> =>
  new Promise((resolve) => { client.onExit(resolve); });

describe('the status bar, one item saying what mEdit is doing', () => {
  it('shows mEdit\'s state from the start', () => {
    const client = new InMemoryMEditClient();
    client.setStatus('stopped');

    createStatusBar(client, reporterFor);

    expect(h.items).toHaveLength(1);
    expect(theItem().text).toBe('$(circle-slash) mEdit: Stopped');
    expect(theItem().shown).toBe(true);
  });

  it.each([
    ['starting', '$(loading~spin) mEdit: Starting…'],
    ['running', '$(plug) mEdit: Running'],
    ['disconnected', '$(error) mEdit: Disconnected'],
    ['stopped', '$(circle-slash) mEdit: Stopped'],
  ] as const)('says %s on every change to it', (status, text) => {
    const client = new InMemoryMEditClient();
    createStatusBar(client, reporterFor);

    client.setStatus(status);

    expect(theItem().text).toBe(text);
  });

  it('says Ready once the snapshot is indexed, counting the active plugins', () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    const bar = createStatusBar(client, reporterFor);

    bar.ready(2);

    expect(theItem().text).toBe('$(check) mEdit: Ready (2 plugins)');
  });

  it('gives Ready back to mEdit\'s own state once the snapshot is not indexed', () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    const bar = createStatusBar(client, reporterFor);
    bar.ready(2);

    bar.showMEditState();

    expect(theItem().text).toBe('$(plug) mEdit: Running');
  });

  it('does nothing on a click', () => {
    createStatusBar(new InMemoryMEditClient(), reporterFor);

    expect(theItem().command).toBeUndefined();
  });

  it('is gone once disposed, and hears no further change', () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    const bar = createStatusBar(client, reporterFor);

    bar.dispose();
    client.setStatus('disconnected');

    expect(theItem().disposed).toBe(true);
    expect(theItem().text).toBe('$(plug) mEdit: Running');
  });
});

describe('mEdit stopping', () => {
  it.each([
    ['a launch that left it stopped', () => Promise.resolve(), [{ tag: 'enterEditing', severity: 'error', message: STOPPED, detail: undefined }]],
    ['a launch that threw, with its reason', () => Promise.reject(new Error('no port')), [{ tag: 'launch', severity: 'error', message: STOPPED, detail: 'no port' }]],
    ['a launch that came up, not at all', (client: InMemoryMEditClient) => { client.setStatus('running'); return Promise.resolve(); }, []],
  ] as const)('reports %s, once', async (_case, start, expected) => {
    const client = new InMemoryMEditClient();
    client.setStatus('stopped');
    client.answerStart(() => start(client));
    createStatusBar(client, reporterFor);
    const launched = launchedBy(client);

    await client.start();
    await launched;

    expect(reports).toEqual(expected);
  });

  it('is reported as stopped under its own report when mEdit exits', async () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    createStatusBar(client, reporterFor);
    const exited = exitOf(client);

    client.crashed();
    await exited;

    expect(reports).toEqual([{ tag: 'mEditExit', severity: 'error', message: STOPPED, detail: undefined }]);
  });

  it('is not reported once disposed', async () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    createStatusBar(client, reporterFor).dispose();
    const exited = exitOf(client);

    client.crashed();
    await exited;

    expect(reports).toEqual([]);
  });
});
