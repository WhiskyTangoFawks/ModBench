import { describe, it, expect, vi, beforeEach } from 'vitest';

const vscodeBridgeAcquiredAtModuleLoad = vi.hoisted(() => ({ postMessage: vi.fn() }));
const tab = vi.hoisted(() => {
  let state: unknown;
  return { getState: () => state, setState: (next: unknown) => { state = next; } };
});
vi.mock('./vscode', () => ({ vscode: vscodeBridgeAcquiredAtModuleLoad, tabState: tab }));

import { createRecordPanelClient } from './RecordPanelClient';
import { columnKey } from '../../src/wire/columnKey';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from '../../src/wire/messages';

function lastRequestId(): string {
  const msg = vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0];
  if (msg?.type !== WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD) throw new Error('no REQUEST_RECORD_LOAD was posted');
  return msg.requestId;
}

function answer(requestId: string, data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId, documentPlugin: { name: 'A.esp', origin: 'ModA' }, modsByOrigin: {}, ...data },
  }));
}

beforeEach(() => {
  vi.mocked(vscode.postMessage).mockClear();
  tab.setState(undefined);
  vi.unstubAllGlobals();
});

const postedColumns = () => {
  const msg = vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0];
  return msg?.type === WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD ? msg.columns : undefined;
};

describe('RecordPanelClient.load', () => {
  it('asks the host for the record by formKey, correlated by requestId', () => {
    void createRecordPanelClient().load('000001:A.esp');

    const requestId = lastRequestId();
    expect(requestId).toBeTruthy();
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId, formKey: '000001:A.esp', columns: [],
    });
  });

  it('reads a record held by no active plugin as a null result, not a failure', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), { ok: true, compare: null, plugins: null, conflictsComputed: true, loadFailures: [] });

    expect(await promise).toMatchObject({ ok: true, result: null });
  });

  it('returns a composite view on success', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' },
      plugins: [{ name: 'A.esp', origin: 'Data', isImmutable: true, loadOrderIndex: 0 }], conflictsComputed: true, loadFailures: [],
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result?.conflictAll).toBe('OnlyOne');
    expect(r.immutableSet).toEqual(new Set([columnKey({ name: 'A.esp', origin: 'Data' })]));
    expect(r.conflictsComputed).toBe(true);
  });

  it('keys immutableSet by compound identity, so two same-filename different-origin plugins stay distinct', async () => {
    const promise = createRecordPanelClient().load('000001:A.esm');
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' },
      plugins: [
        { name: 'Shared.esp', isImmutable: true, loadOrderIndex: 0, origin: 'ModA' },
        { name: 'Shared.esp', isImmutable: false, loadOrderIndex: 1, origin: 'ModB' },
      ],
      conflictsComputed: true, loadFailures: [],
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.immutableSet).toEqual(new Set([columnKey({ name: 'Shared.esp', origin: 'ModA' })]));
    expect(r.immutableSet?.has(columnKey({ name: 'Shared.esp', origin: 'ModB' }))).toBe(false);
  });

  it('fails the whole load when the host answers refused', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), { ok: false, error: 'HTTP 404' });

    expect(await promise).toEqual({ ok: false, error: 'HTTP 404' });
  });

  it('leaves plugins null when the host answers with a null plugin list', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' }, plugins: null, conflictsComputed: true, loadFailures: [],
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.immutableSet).toBeNull();
  });

  it('returns the plugins mEdit cannot read', async () => {
    const loadFailures = [{ name: 'Bad.esp', origin: 'Mod', reason: 'truncated' }];
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' }, plugins: [], conflictsComputed: true, loadFailures,
    });

    expect(await promise).toMatchObject({ ok: true, loadFailures });
  });

  it('returns conflictsComputed false while the sweep is still outstanding', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' }, plugins: [], conflictsComputed: false, loadFailures: [],
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflictsComputed).toBe(false);
  });

  it('names the file\'s column by the copy of its record the tab\'s document holds, the first of several records compared', async () => {
    const copy = (formKey: string, plugin: string, origin: string, column: string) => ({ formKey, plugin, origin, column });
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), {
      ok: true, plugins: [], conflictsComputed: true, loadFailures: [], documentPlugin: { name: 'A.esp', origin: 'ModA' },
      compare: { diffs: [], conflictAll: 'NoConflict', overrides: [
        copy('000001:A.esp', 'A.esp', 'ModB', '0#A.esp|ModB'), copy('000002:A.esp', 'A.esp', 'ModA', '1#A.esp|ModA'),
        copy('000001:A.esp', 'A.esp', 'ModA', '2#A.esp|ModA'), copy('000001:A.esp', 'A.esp', 'ModA', '3#A.esp|ModA'),
      ] },
    });

    expect(await promise).toMatchObject({ ok: true, fileColumn: '2#A.esp|ModA' });
  });

  it('ignores an answer whose requestId does not match this load\'s own request', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer('some-other-requestId', {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' }, plugins: [], conflictsComputed: true, loadFailures: [],
    });
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'NoConflict' }, plugins: [], conflictsComputed: true, loadFailures: [],
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result?.conflictAll).toBe('NoConflict');
  });
});

describe('RecordPanelClient, the records a tab shows beside its document\'s own', () => {
  const ammo = { formKey: '000002:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } };
  const knife = { formKey: '000003:C.esp', plugin: { name: 'C.esp', origin: 'ModC' } };

  it('reads them as the page was given them, and keeps them with the tab', () => {
    vi.stubGlobal('mEditColumns', [ammo]);

    void createRecordPanelClient().load('000001:A.esp');

    expect(postedColumns()).toEqual([ammo]);
    expect(tab.getState()).toEqual({ columns: [ammo] });
  });

  it('reads them as the tab kept them, which VS Code restores with the tab after a reload, over the page\'s', () => {
    tab.setState({ columns: [knife] });
    vi.stubGlobal('mEditColumns', []);

    void createRecordPanelClient().load('000001:A.esp');

    expect(postedColumns()).toEqual([knife]);
  });

  it('reads the ones shown since, and keeps them with the tab', () => {
    vi.stubGlobal('mEditColumns', [ammo]);
    const client = createRecordPanelClient();

    client.showColumns([knife]);
    void client.load('000001:A.esp');

    expect(postedColumns()).toEqual([knife]);
    expect(tab.getState()).toEqual({ columns: [knife] });
  });

  it('reads none once the host shows none, though the page gave some', () => {
    vi.stubGlobal('mEditColumns', [ammo]);
    const client = createRecordPanelClient();

    client.showColumns([]);
    void client.load('000001:A.esp');

    expect(postedColumns()).toEqual([]);
    expect(tab.getState()).toEqual({ columns: [] });
  });
});
