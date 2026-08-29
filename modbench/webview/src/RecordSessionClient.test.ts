import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Issue #167 (review): conditionRunOnTargets() logs failures via the same vscode.postMessage
// bridge RecordPanel's own logAction uses (vscode.ts's acquireVsCodeApi() at module load) —
// stubbed here the same way RecordPanel.test.tsx already does, since most tests below don't care
// about logging itself (see the dedicated describe block further down for that).
vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { createRecordSessionClient } from './RecordSessionClient';
import { columnKey } from './types';
import { vscode } from './vscode';

// The client is the record panel's single backend seam. `fetch` is the genuine external
// boundary here, so these tests stub it — everything above the client injects a fake client
// instead (see RecordPanel.test).

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createRecordSessionClient', () => {

  it('constructs distinct clients per port', () => {
    expect(createRecordSessionClient(5172)).not.toBe(createRecordSessionClient(5173));
  });
});

describe('RecordSessionClient.load', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/changes')) return Promise.resolve(jsonResponse([{ id: 'c1' }]));
      if (url.includes('/plugins')) return Promise.resolve(jsonResponse([{ name: 'A.esp', isImmutable: true, loadOrderIndex: 0 }]));
      // #308: the shared happy-path fixture answers settled — the dedicated describe block below
      // overrides this per test to exercise the false/failed-fetch cases.
      if (url.includes('/session/status')) return Promise.resolve(jsonResponse({ conflictsComputed: true }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('issues compare and plugins in parallel', async () => {
    await createRecordSessionClient(5172).load('000001:A.esp');
    const urls = fetchMock.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : c[0].url));
    expect(urls.some(u => u.includes('/records/000001%3AA.esp/compare'))).toBe(true);
    expect(urls.some(u => u.endsWith('/plugins'))).toBe(true);
  });

  it('returns a composite view on success', async () => {
    const r = await createRecordSessionClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.conflictAll).toBe('OnlyOne');
    // Immutable-set resolution lives behind the client (issue #122 AC). #209: the raw plugin
    // list itself is no longer exposed on LoadResult — it fetches /plugins internally only to
    // derive this set, since its only consumer (the deleted PluginTargetPicker/Add Master
    // dropdown) is gone. #272: keyed by compound column identity (ColumnKey), not the bare
    // plugin name — this fixture has no `origin`, which columnKey() treats as the elided Data
    // origin, same as every pre-#272 fixture.
    expect(r.immutableSet).toEqual(new Set([columnKey('A.esp', null)]));
  });

  // #272 / ADR-0036: the genuinely red case — two PluginInfo entries sharing a filename but
  // differing in origin must produce two distinct Set members, or one origin's mutability
  // silently wins for both columns (RecordPanel.tsx's immutableSet.has(...) checks). Pre-#272,
  // `.map(p => p.name)` collapsed both into one entry.
  it('keys immutableSet by compound identity, so two same-filename different-origin plugins stay distinct', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/changes')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/plugins')) {
        return Promise.resolve(jsonResponse([
          { name: 'Shared.esp', isImmutable: true, loadOrderIndex: 0, origin: 'ModA' },
          { name: 'Shared.esp', isImmutable: false, loadOrderIndex: 1, origin: 'ModB' },
        ]));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    const r = await createRecordSessionClient(5172).load('000001:A.esm');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.immutableSet).toEqual(new Set([columnKey('Shared.esp', 'ModA')]));
    expect(r.immutableSet?.has(columnKey('Shared.esp', 'ModB'))).toBe(false);
  });

  // #304 / ADR-0036: notInLoadOrderSet mirrors immutableSet's own compound-identity construction
  // (same PluginInfo list, same columnKey()) — a copy the load order doesn't name is immutable
  // *and* absent from it, and PluginHeader needs the second fact independently of the first (a
  // vanilla master is immutable but still in the load order, and must not read the same way).
  it('computes notInLoadOrderSet from inLoadOrder flags, keyed by compound identity like immutableSet', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/changes')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/plugins')) {
        return Promise.resolve(jsonResponse([
          { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0, inLoadOrder: true },
          { name: 'Shared.esp', isImmutable: true, loadOrderIndex: 1, origin: 'ModA', inLoadOrder: true },
          { name: 'Shared.esp', isImmutable: true, loadOrderIndex: 1, origin: 'ModB', inLoadOrder: false },
        ]));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    const r = await createRecordSessionClient(5172).load('000001:A.esm');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notInLoadOrderSet).toEqual(new Set([columnKey('Shared.esp', 'ModB')]));
    expect(r.notInLoadOrderSet?.has(columnKey('Fallout4.esm', null))).toBe(false);
    expect(r.notInLoadOrderSet?.has(columnKey('Shared.esp', 'ModA'))).toBe(false);
  });

  // A stale/older response shape omitting the field must default to "in load order" — the
  // overwhelmingly common case, and the one that leaves every pre-existing fixture (none of which
  // set inLoadOrder) reading as it always has.
  it('treats a missing inLoadOrder flag as in-load-order, not shadowed', async () => {
    const r = await createRecordSessionClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notInLoadOrderSet).toEqual(new Set());
  });

  it('fails the whole load when compare fails', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({}, 404));
      return Promise.resolve(jsonResponse([]));
    });
    const r = await createRecordSessionClient(5172).load('000001:A.esp');
    expect(r).toEqual({ ok: false, error: 'HTTP 404' });
  });

  it('leaves changes/plugins null when their own fetch fails but compare succeeds', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      return Promise.resolve(jsonResponse({}, 500));
    });
    const r = await createRecordSessionClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.immutableSet).toBeNull();
    expect(r.notInLoadOrderSet).toBeNull();
  });

  // #308 / ADR-0035: the record panel's own half of "an absent conflict badge must never be
  // mistakable for 'no conflict'" — load() reads GET /session/status alongside compare/changes/
  // plugins so the panel can state, honestly, whether the comparison it is about to render is
  // settled.
  it('returns conflictsComputed true when the sweep has run', async () => {
    const r = await createRecordSessionClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflictsComputed).toBe(true);
  });

  it('returns conflictsComputed false while the sweep is still outstanding', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/changes')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/plugins')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/session/status')) return Promise.resolve(jsonResponse({ conflictsComputed: false }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    const r = await createRecordSessionClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflictsComputed).toBe(false);
  });

  // Fails *closed*: an absent answer must read the same as "not computed", never as "settled" —
  // the opposite default would let a status-fetch blip render a settled-looking grid over a
  // comparison that was never actually checked (ADR-0026 / ADR-0035).
  it('defaults conflictsComputed to false when the status fetch itself fails', async () => {
    fetchMock.mockImplementation((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/compare')) return Promise.resolve(jsonResponse({ overrides: [], diffs: [], conflictAll: 'OnlyOne' }));
      if (url.includes('/changes')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/plugins')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/session/status')) return Promise.resolve(jsonResponse({}, 500));
      return Promise.resolve(jsonResponse({}, 404));
    });
    const r = await createRecordSessionClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflictsComputed).toBe(false);
  });

  // #544: "Compare with winner" delta mode — the grid shows Effective vs Effective for exactly
  // the peer/winner pair, never every other participating override GetCompare would otherwise
  // hand back (a genuine third-party conflict on the same FormKey, say — *or* the peer's own mod
  // folder shipping a second plugin that independently overrides this same FormKey under the same
  // origin, review finding #1 — origin alone doesn't name a column). Filtering happens here, not
  // in RecordPanel, so every downstream derivation (columns, editableColumns, ...) that reads
  // result.overrides "just works" against the already-scoped set.
  describe('with a deltaScope', () => {
    beforeEach(() => {
      fetchMock.mockImplementation((input: Request | string) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/compare')) {
          return Promise.resolve(jsonResponse({
            overrides: [
              { formKey: '000800:Shared.esp', plugin: 'Shared.esp', origin: 'ModA', editorId: 'FromA' },
              { formKey: '000800:Shared.esp', plugin: 'Shared.esp', origin: 'ModB', editorId: 'FromB' },
              { formKey: '000800:Shared.esp', plugin: 'Shared.esp', origin: 'ModC', editorId: 'FromC' },
              // review finding #1: same origin as the peer, but a different plugin — an unrelated
              // row that must not survive scoping just because its origin happens to match.
              { formKey: '000800:Shared.esp', plugin: 'OtherPlugin.esp', origin: 'ModB', editorId: 'FromOtherPlugin' },
            ],
            diffs: [], conflictAll: 'Conflict',
          }));
        }
        if (url.includes('/plugins')) return Promise.resolve(jsonResponse([]));
        if (url.includes('/session/status')) return Promise.resolve(jsonResponse({ conflictsComputed: true }));
        return Promise.resolve(jsonResponse({}, 404));
      });
    });

    it('keeps only the two named origins for the named plugin, dropping every other override', async () => {
      const r = await createRecordSessionClient(5172).load(
        '000800:Shared.esp', { plugin: 'Shared.esp', winnerOrigin: 'ModA', peerOrigin: 'ModB' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.result.overrides.map(o => `${o.plugin}@${o.origin}`)).toEqual(['Shared.esp@ModA', 'Shared.esp@ModB']);
    });

    it('leaves the full override set untouched when no deltaScope is given', async () => {
      const r = await createRecordSessionClient(5172).load('000800:Shared.esp');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.result.overrides.map(o => o.origin)).toEqual(['ModA', 'ModB', 'ModC', 'ModB']);
    });
  });
});

describe('RecordSessionClient.conditionRunOnTargets', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse(['Subject', 'Reference'])));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('GETs the Run On target catalog', async () => {
    const targets = await createRecordSessionClient(5172).conditionRunOnTargets();
    const url = typeof fetchMock.mock.calls[0][0] === 'string' ? fetchMock.mock.calls[0][0] : fetchMock.mock.calls[0][0].url;
    expect(url).toContain('/condition-run-on-targets');
    expect(targets).toEqual(['Subject', 'Reference']);
  });

  // Issue #167 (review): a non-ok response degrades to [] (never rejects — the Run On dropdown
  // simply has nothing to show, not a blocking error) but must log, mirroring
  // PluginRepository.getConditionFunctions()'s own contract rather than swallowing silently.
  it('returns [] and logs a warning when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const targets = await createRecordSessionClient(5172).conditionRunOnTargets();
    expect(targets).toEqual([]);
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  it('returns [] and logs a warning when the fetch itself throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const targets = await createRecordSessionClient(5172).conditionRunOnTargets();
    expect(targets).toEqual([]);
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });
});
