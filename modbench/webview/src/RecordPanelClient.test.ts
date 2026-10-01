import { describe, it, expect, vi, beforeEach } from 'vitest';

// The webview's vscode bridge is acquired at module load, so it must be stubbed before import.
vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { createRecordPanelClient } from './RecordPanelClient';
import { columnKey } from './columnKey';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

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

  it('returns a composite view on success', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' },
      plugins: [{ name: 'A.esp', isImmutable: true, loadOrderIndex: 0 }], conflictsComputed: true,
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.conflictAll).toBe('OnlyOne');
    // Keyed by compound column identity, not the bare plugin name; this fixture has no
    // `origin`, which columnKey() treats as the elided Data origin.
    expect(r.immutableSet).toEqual(new Set([columnKey('A.esp', null)]));
    expect(r.conflictsComputed).toBe(true);
  });

  // ADR-0012: two entries sharing a filename but differing in origin must produce two distinct
  // Set members, or one origin's mutability silently applies to both columns.
  it('keys immutableSet by compound identity, so two same-filename different-origin plugins stay distinct', async () => {
    const promise = createRecordPanelClient().load('000001:A.esm');
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' },
      plugins: [
        { name: 'Shared.esp', isImmutable: true, loadOrderIndex: 0, origin: 'ModA' },
        { name: 'Shared.esp', isImmutable: false, loadOrderIndex: 1, origin: 'ModB' },
      ],
      conflictsComputed: true,
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.immutableSet).toEqual(new Set([columnKey('Shared.esp', 'ModA')]));
    expect(r.immutableSet?.has(columnKey('Shared.esp', 'ModB'))).toBe(false);
  });

  it('fails the whole load when the host answers refused', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), { ok: false, error: 'HTTP 404' });

    expect(await promise).toEqual({ ok: false, error: 'HTTP 404' });
  });

  it('leaves plugins null when the host answers with a null plugin list', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' }, plugins: null, conflictsComputed: true,
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.immutableSet).toBeNull();
  });

  it('returns conflictsComputed false while the sweep is still outstanding', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' }, plugins: [], conflictsComputed: false,
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflictsComputed).toBe(false);
  });

  // The rival: a client that resolves on the first RECORD_LOAD_ANSWERED it sees, so a stale
  // reply to an earlier load() call would settle a newer one with the wrong record.
  it('ignores an answer whose requestId does not match this load\'s own request', async () => {
    const promise = createRecordPanelClient().load('000001:A.esp');
    answer('some-other-requestId', {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' }, plugins: [], conflictsComputed: true,
    });
    answer(lastRequestId(), {
      ok: true, compare: { overrides: [], diffs: [], conflictAll: 'NoConflict' }, plugins: [], conflictsComputed: true,
    });

    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.conflictAll).toBe('NoConflict');
  });
});
