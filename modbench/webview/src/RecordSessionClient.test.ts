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
  it('exposes the record-session operations', () => {
    const client = createRecordSessionClient(5172);
    for (const m of ['load', 'save', 'revert', 'copyTo', 'removeOverride', 'createRecord', 'groupMembers', 'saveGroup', 'revertGroup', 'conditionRunOnTargets']) {
      expect(client).toHaveProperty(m);
    }
  });

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
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('issues compare, changes, and plugins in parallel', async () => {
    await createRecordSessionClient(5172).load('000001:A.esp');
    const urls = fetchMock.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : c[0].url));
    expect(urls.some(u => u.includes('/records/000001%3AA.esp/compare'))).toBe(true);
    expect(urls.some(u => u.includes('/changes?formKey=000001%3AA.esp'))).toBe(true);
    expect(urls.some(u => u.endsWith('/plugins'))).toBe(true);
  });

  it('returns a composite view on success', async () => {
    const r = await createRecordSessionClient(5172).load('000001:A.esp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.conflictAll).toBe('OnlyOne');
    expect(r.changes).toEqual([{ id: 'c1' }]);
    // Immutable-set resolution lives behind the client (issue #122 AC). #209: the raw plugin
    // list itself is no longer exposed on LoadResult — it fetches /plugins internally only to
    // derive this set, since its only consumer (the deleted PluginTargetPicker/Add Master
    // dropdown) is gone. #272: keyed by compound column identity (ColumnKey), not the bare
    // plugin name — this fixture has no `origin`, which columnKey() treats as the elided Data
    // origin, same as every pre-#272 fixture.
    expect(r.immutableSet).toEqual(new Set([columnKey('A.esp')]));
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
    expect(r.changes).toBeNull();
    expect(r.immutableSet).toBeNull();
  });
});

describe('RecordSessionClient writes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('save PATCHes the record with the user change payload', async () => {
    await createRecordSessionClient(5172).save('000001:A.esp', 'A.esp', { Name: 'x' });
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.method).toBe('PATCH');
    expect(req.url).toContain('/records/000001%3AA.esp');
    expect(await req.clone().json()).toMatchObject({ plugin: 'A.esp', fields: { Name: 'x' }, source: 'user' });
  });

  it('save threads changeType when given', async () => {
    await createRecordSessionClient(5172).save('000001:A.esp', 'A.esp', { p: {} }, 'vmad_struct_op');
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(await req.clone().json()).toMatchObject({ changeType: 'vmad_struct_op' });
  });

  it('revert DELETEs the change', async () => {
    await createRecordSessionClient(5172).revert('abc');
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.method).toBe('DELETE');
    expect(req.url).toContain('/changes/abc');
  });

  it('copyTo POSTs to the copy-to endpoint', async () => {
    await createRecordSessionClient(5172).copyTo('000001:A.esp', 'B.esp');
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/records/000001%3AA.esp/copy-to/B.esp');
    expect(await req.clone().json()).toEqual({});
  });

  // Issue #202: Copy as Override copies the right-clicked column, not necessarily the winner —
  // sourcePlugin, when given, must reach the backend in the request body.
  it('copyTo includes sourcePlugin in the request body when given', async () => {
    await createRecordSessionClient(5172).copyTo('000001:A.esp', 'B.esp', 'C.esp');
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(await req.clone().json()).toEqual({ sourcePlugin: 'C.esp' });
  });

  it('removeOverride POSTs a delete-records request', async () => {
    await createRecordSessionClient(5172).removeOverride('000001:A.esp', 'A.esp');
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.url).toContain('/records/delete');
    expect(await req.clone().json()).toEqual({ records: [{ formKey: '000001:A.esp', plugin: 'A.esp' }] });
  });

  it('createRecord POSTs to the plugin records endpoint', async () => {
    await createRecordSessionClient(5172).createRecord('B.esp', 'npc_');
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.url).toContain('/plugins/B.esp/records');
    expect(await req.clone().json()).toMatchObject({ recordType: 'npc_', source: 'user' });
  });

  it('createRecord omits recordType when it is undefined', async () => {
    await createRecordSessionClient(5172).createRecord('B.esp', undefined);
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(await req.clone().json()).toEqual({ source: 'user' });
  });

  it('returns a typed error result for a non-ok response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'read-only' }, 409));
    const result = await createRecordSessionClient(5172).save('000001:A.esp', 'A.esp', {});
    expect(result).toEqual({ ok: false, status: 409, error: { detail: 'read-only' } });
  });

  it('saveGroup POSTs to the change-group save endpoint', async () => {
    await createRecordSessionClient(5172).saveGroup('g1');
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/change-groups/g1/save');
  });

  it('saveGroup returns a typed success result', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ byPlugin: {}, reindexFailure: null }));
    const result = await createRecordSessionClient(5172).saveGroup('g1');
    expect(result).toEqual({ ok: true, data: { byPlugin: {}, reindexFailure: null } });
  });

  it('revertGroup DELETEs the whole component by member change id', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await createRecordSessionClient(5172).revertGroup('g1');
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.method).toBe('DELETE');
    expect(req.url).toContain('/changes/group/g1');
  });
});

describe('RecordSessionClient.groupMembers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse([{ id: 'c1' }, { id: 'c2' }])));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('GETs the changes in the component the change id belongs to', async () => {
    const members = await createRecordSessionClient(5172).groupMembers('c1');
    const url = typeof fetchMock.mock.calls[0][0] === 'string' ? fetchMock.mock.calls[0][0] : fetchMock.mock.calls[0][0].url;
    expect(url).toContain('/changes?groupId=c1');
    expect(members).toEqual([{ id: 'c1' }, { id: 'c2' }]);
  });

  it('returns [] when the read fails, so the panel can fall back to a plain revert', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    expect(await createRecordSessionClient(5172).groupMembers('c1')).toEqual([]);
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
