import { describe, it, expect, vi, beforeEach } from 'vitest';

const vscodeBridgeAcquiredAtModuleLoad = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscode', () => ({ vscode: vscodeBridgeAcquiredAtModuleLoad }));

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
    data: { type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId, ...data },
  }));
}

beforeEach(() => { vi.mocked(vscode.postMessage).mockClear(); });

describe('RecordPanelClient.load', () => {
  it('asks the host for the record by formKey, correlated by requestId', () => {
    void createRecordPanelClient().load('000001:A.esp');

    const requestId = lastRequestId();
    expect(requestId).toBeTruthy();
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId, formKey: '000001:A.esp',
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
