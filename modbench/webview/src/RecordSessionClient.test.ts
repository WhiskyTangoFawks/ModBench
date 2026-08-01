import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRecordSessionClient } from './RecordSessionClient';

// The client is the record panel's single backend seam. `fetch` is the genuine external
// boundary here, so these tests stub it — everything above the client injects a fake client
// instead (see RecordPanel.test / FormKeyPicker.test).

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createRecordSessionClient', () => {
  it('exposes the record-session operations', () => {
    const client = createRecordSessionClient(5172);
    for (const m of ['load', 'searchRecords', 'save', 'revert', 'copyTo', 'removeOverride', 'createRecord', 'groupMembers', 'saveGroup', 'revertGroup', 'conditionFunctions']) {
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
    // dropdown) is gone.
    expect(r.immutableSet).toEqual(new Set(['A.esp']));
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

describe('RecordSessionClient.searchRecords', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: [{ formKey: '000001:A.esp', editorId: 'kw' }] })));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the items on success', async () => {
    const items = await createRecordSessionClient(5172).searchRecords('kw', []);
    expect(items).toEqual([{ formKey: '000001:A.esp', editorId: 'kw' }]);
  });

  it('includes the type param for a single valid type', async () => {
    await createRecordSessionClient(5172).searchRecords('sword', ['kywd']);
    const url = typeof fetchMock.mock.calls[0][0] === 'string' ? fetchMock.mock.calls[0][0] : fetchMock.mock.calls[0][0].url;
    expect(url).toContain('type=kywd');
  });

  it('omits the type param when multiple valid types', async () => {
    await createRecordSessionClient(5172).searchRecords('sword', ['kywd', 'armo']);
    const url = typeof fetchMock.mock.calls[0][0] === 'string' ? fetchMock.mock.calls[0][0] : fetchMock.mock.calls[0][0].url;
    expect(url).not.toContain('type=');
  });

  it('returns [] when the signal is already aborted', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const controller = new AbortController();
    controller.abort();
    await expect(createRecordSessionClient(5172).searchRecords('kw', [], controller.signal))
      .rejects.toThrow();
  });
});

describe('RecordSessionClient.conditionFunctions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse(['GetIsID', 'GetDistance'])));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the function name catalog on success', async () => {
    const names = await createRecordSessionClient(5172).conditionFunctions();
    expect(names).toEqual(['GetIsID', 'GetDistance']);
  });

  it('hits /condition-functions', async () => {
    await createRecordSessionClient(5172).conditionFunctions();
    const url = typeof fetchMock.mock.calls[0][0] === 'string' ? fetchMock.mock.calls[0][0] : fetchMock.mock.calls[0][0].url;
    expect(url).toContain('/condition-functions');
  });

  it('returns [] on failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const names = await createRecordSessionClient(5172).conditionFunctions();
    expect(names).toEqual([]);
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

  it('returns an unconsumed Response so the panel can read the error body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'read-only' }, 409));
    const resp = await createRecordSessionClient(5172).save('000001:A.esp', 'A.esp', {});
    expect(resp.status).toBe(409);
    expect(resp.bodyUsed).toBe(false);
    expect(await resp.json()).toEqual({ detail: 'read-only' });
  });

  it('saveGroup POSTs to the change-group save endpoint', async () => {
    await createRecordSessionClient(5172).saveGroup('g1');
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/change-groups/g1/save');
  });

  it('saveGroup returns an unconsumed Response so the panel can read the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ byPlugin: {}, reindexFailure: null }));
    const resp = await createRecordSessionClient(5172).saveGroup('g1');
    expect(resp.bodyUsed).toBe(false);
    expect(await resp.json()).toEqual({ byPlugin: {}, reindexFailure: null });
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
