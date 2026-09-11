import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The webview's vscode bridge is acquired at module load, so it must be stubbed before import.
vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { createRecordPanelClient } from './RecordPanelClient';
import { columnKey } from './types';

// `fetch` is the genuine external boundary here; everything above the client injects a fake.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createRecordPanelClient', () => {

  it('constructs distinct clients per port', () => {
    expect(createRecordPanelClient(5172)).not.toBe(createRecordPanelClient(5173));
  });
});

describe('RecordPanelClient.load', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/plugins')) return Promise.resolve(jsonResponse([{ name: 'A.esp', isImmutable: true, loadOrderIndex: 0 }]));
      // The shared happy-path fixture answers settled; the status cases override it.
      if (url.includes('/load-order/status')) return Promise.resolve(jsonResponse({ conflictsComputed: true }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('issues compare and plugins in parallel', async () => {
    await createRecordPanelClient(5172).load('000001:A.esp');
    const urls = fetchMock.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : c[0].url));
    expect(urls.some(u => u.includes('/records/000001%3AA.esp/compare'))).toBe(true);
    expect(urls.some(u => u.endsWith('/plugins'))).toBe(true);
  });

  it('returns a composite view on success', async () => {
    const r = await createRecordPanelClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.conflictAll).toBe('OnlyOne');
    // Keyed by compound column identity, not the bare plugin name; this fixture has no
    // `origin`, which columnKey() treats as the elided Data origin.
    expect(r.immutableSet).toEqual(new Set([columnKey('A.esp', null)]));
  });

  // ADR-0012: two entries sharing a filename but differing in origin must produce two distinct
  // Set members, or one origin's mutability silently applies to both columns.
  it('keys immutableSet by compound identity, so two same-filename different-origin plugins stay distinct', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/plugins')) {
        return Promise.resolve(jsonResponse([
          { name: 'Shared.esp', isImmutable: true, loadOrderIndex: 0, origin: 'ModA' },
          { name: 'Shared.esp', isImmutable: false, loadOrderIndex: 1, origin: 'ModB' },
        ]));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    const r = await createRecordPanelClient(5172).load('000001:A.esm');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.immutableSet).toEqual(new Set([columnKey('Shared.esp', 'ModA')]));
    expect(r.immutableSet?.has(columnKey('Shared.esp', 'ModB'))).toBe(false);
  });

  // ADR-0012: a copy the load order does not name is both immutable and absent from it, and
  // PluginHeader needs the second fact independently — a vanilla master is only the first.
  it('computes notInLoadOrderSet from inLoadOrder flags, keyed by compound identity like immutableSet', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/plugins')) {
        return Promise.resolve(jsonResponse([
          { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0, inLoadOrder: true },
          { name: 'Shared.esp', isImmutable: true, loadOrderIndex: 1, origin: 'ModA', inLoadOrder: true },
          { name: 'Shared.esp', isImmutable: true, loadOrderIndex: 1, origin: 'ModB', inLoadOrder: false },
        ]));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    const r = await createRecordPanelClient(5172).load('000001:A.esm');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notInLoadOrderSet).toEqual(new Set([columnKey('Shared.esp', 'ModB')]));
    expect(r.notInLoadOrderSet?.has(columnKey('Fallout4.esm', null))).toBe(false);
    expect(r.notInLoadOrderSet?.has(columnKey('Shared.esp', 'ModA'))).toBe(false);
  });


  it('fails the whole load when compare fails', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({}, 404));
      return Promise.resolve(jsonResponse([]));
    });
    const r = await createRecordPanelClient(5172).load('000001:A.esp');
    expect(r).toEqual({ ok: false, error: 'HTTP 404' });
  });

  it('leaves plugins null when its own fetch fails but compare succeeds', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      return Promise.resolve(jsonResponse({}, 500));
    });
    const r = await createRecordPanelClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.immutableSet).toBeNull();
    expect(r.notInLoadOrderSet).toBeNull();
  });

  // ADR-0013: an absent conflict badge must never be mistakable for "no conflict", so the panel
  // reads the load-order status alongside the comparison it is about to render.
  it('returns conflictsComputed true when the sweep has run', async () => {
    const r = await createRecordPanelClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflictsComputed).toBe(true);
  });

  it('returns conflictsComputed false while the sweep is still outstanding', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/plugins')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/load-order/status')) return Promise.resolve(jsonResponse({ conflictsComputed: false }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    const r = await createRecordPanelClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflictsComputed).toBe(false);
  });

  // Fails closed: the opposite default would let a status-fetch blip render a settled-looking
  // grid over a comparison that was never checked (ADR-0019, ADR-0013).
  it('defaults conflictsComputed to false when the status fetch itself fails', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/plugins')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/load-order/status')) return Promise.resolve(jsonResponse({}, 500));
      return Promise.resolve(jsonResponse({}, 404));
    });
    const r = await createRecordPanelClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflictsComputed).toBe(false);
  });
});
