import { describe, it, expect, vi } from 'vitest';
import { ApiPluginRepository } from '../PluginRepository';
import type { PluginMetadata, RecordSummary } from '../ApiClient';

function makePlugin(i: number): PluginMetadata {
  return {
    name: `Plugin${i}.esp`,
    path: `/data/Plugin${i}.esp`,
    loadOrderIndex: i,
    isLight: false,
    isMaster: false,
    masters: [],
    recordCount: 10,
    isImmutable: false,
    origin: 'Data',
    masterIssues: [],
    hasMatchingRecords: true,
  };
}

// openapi-fetch already reads the body to produce `error` on a non-ok response,
// draining it — a real Response throws "Body is unusable" on a second .text() call.
function nonOkClient() {
  return {
    GET: vi.fn().mockResolvedValue({
      data: undefined,
      error: 'boom',
      response: {
        ok: false,
        status: 500,
        text: () => Promise.reject(new TypeError('Body is unusable: Body has already been read')),
      },
    }),
  } as any;
}

function makeRecord(i: number): RecordSummary {
  return {
    formKey: `Fallout4.esm:${String(i).padStart(6, '0')}`,
    plugin: 'Fallout4.esm',
    loadOrderIndex: 0,
    isWinner: true,
    editorId: `Record${i}`,
  };
}

describe('ApiPluginRepository.getPlugins', () => {
  it('calls GET /plugins and returns the data', async () => {
    const plugins = [makePlugin(0), makePlugin(1)];
    const client = { GET: vi.fn().mockResolvedValue({ data: plugins, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getPlugins();

    expect(result).toEqual(plugins);
    expect(client.GET).toHaveBeenCalledWith('/plugins', expect.anything());
  });

  it('returns empty array for a 200 response with no data (empty session)', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: undefined, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    expect(await repo.getPlugins()).toEqual([]);
  });

  it('throws on a non-OK response so the tree can surface an error instead of an empty list', async () => {
    // Querying /plugins before a session is loaded returns 503 "No session loaded";
    // that must not be silently swallowed into [] (issue #75).
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: undefined,
        error: 'No session loaded.',
        response: {
          ok: false,
          status: 503,
          text: () => Promise.reject(new TypeError('Body is unusable: Body has already been read')),
        },
      }),
    } as any;
    const repo = new ApiPluginRepository(client);

    // Pin the exact message: it is the user-visible #75 ErrorNode text and must not
    // drift (e.g. to a method-signature label) when the error path is refactored.
    await expect(repo.getPlugins()).rejects.toThrow(/GET \/plugins failed \(503\)/);
  });

  it('maps origin from the wire PluginResponse (#275 / ADR-0036) instead of dropping it', async () => {
    // #272 review flagged this: PluginResponse.Origin has been on the wire since #269, but
    // toPluginMetadata() never carried it into the frontend's PluginMetadata.
    const raw = [{ ...makePlugin(0), origin: 'SomeMod' }];
    const client = { GET: vi.fn().mockResolvedValue({ data: raw, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getPlugins();

    expect(result[0].origin).toBe('SomeMod');
  });

  // #277 / ADR-0037 AC1/AC4: this is what lets the composite decorate a row without a
  // second read — the classification is already attached to the plugin it describes.
  it('maps masterIssues from the wire PluginResponse, distinguishing direct from unloadable', async () => {
    const raw = [{
      ...makePlugin(0),
      masterIssues: [
        { masterName: 'Ghost.esm', kind: 'DirectlyMissing' },
        { masterName: 'Broken.esm', kind: 'Unloadable' },
      ],
    }];
    const client = { GET: vi.fn().mockResolvedValue({ data: raw, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getPlugins();

    expect(result[0].masterIssues).toEqual([
      { masterName: 'Ghost.esm', kind: 'DirectlyMissing' },
      { masterName: 'Broken.esm', kind: 'Unloadable' },
    ]);
  });

  it('defaults masterIssues to empty when the wire omits it', async () => {
    const raw = [{ name: 'Plugin0.esp', path: '/data/Plugin0.esp', loadOrderIndex: 0, origin: 'Data' }];
    const client = { GET: vi.fn().mockResolvedValue({ data: raw, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getPlugins();

    expect(result[0].masterIssues).toEqual([]);
  });
});

describe('ApiPluginRepository.getRecordTypes', () => {
  it('calls GET /plugins/{plugin}/record-types with correct path param', async () => {
    const types = [
      { type: 'WEAP', count: 42, displayName: 'Weapon' },
      { type: 'NPC_', count: 10, displayName: 'Non-Player Character' },
    ];
    const client = { GET: vi.fn().mockResolvedValue({ data: types, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getRecordTypes('MyPlugin.esp');

    expect(result).toEqual(types);
    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/record-types',
      expect.objectContaining({ params: { path: { plugin: 'MyPlugin.esp' }, query: {} } }),
    );
  });

  it('falls back to the raw type when displayName is absent from the response', async () => {
    // Issue #110: additive field — a stale/older backend response without displayName
    // must not surface `undefined` as a tree label.
    const types = [{ type: 'WEAP', count: 42 }];
    const client = { GET: vi.fn().mockResolvedValue({ data: types, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getRecordTypes('MyPlugin.esp');

    expect(result).toEqual([{ type: 'WEAP', count: 42, displayName: 'WEAP' }]);
  });

  it('returns empty array when data is undefined', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: undefined, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    expect(await repo.getRecordTypes('Plugin.esp')).toEqual([]);
  });

  it('throws on a non-OK response so the tree can surface an error instead of an empty list', async () => {
    const repo = new ApiPluginRepository(nonOkClient());
    await expect(repo.getRecordTypes('Plugin.esp')).rejects.toThrow(/500/);
  });
});

describe('ApiPluginRepository.getRecords', () => {
  it('calls GET /records with correct query params', async () => {
    const records = [makeRecord(0), makeRecord(1)];
    const client = {
      GET: vi.fn().mockResolvedValue({ data: { items: records, total: 100 }, response: { ok: true } }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getRecords('Fallout4.esm', 'WEAP', 50, 25);

    expect(result.items).toEqual(records);
    expect(result.total).toBe(100);
    expect(client.GET).toHaveBeenCalledWith(
      '/records',
      expect.objectContaining({
        params: { query: { plugin: 'Fallout4.esm', type: 'WEAP', offset: 50, limit: 25 } },
      }),
    );
  });

  it('returns empty result when data is undefined', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: undefined, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getRecords('Plugin.esp', 'WEAP', 0, 50);

    expect(result).toEqual({ items: [], total: 0 });
  });

  it('throws on a non-OK response so the tree can surface an error instead of an empty list', async () => {
    const repo = new ApiPluginRepository(nonOkClient());
    await expect(repo.getRecords('Plugin.esp', 'WEAP', 0, 50)).rejects.toThrow(/500/);
  });
});

describe('ApiPluginRepository.searchRecords', () => {
  // Issue #210: the FormKey picker moved into the extension host — it needs its own record
  // search, mirroring the deleted webview-side RecordSessionClient.searchRecords: `type` is only
  // sent when the field allows exactly one record type, and results are capped at 20.
  it('calls GET /records with search + limit, and type when validTypes has exactly one entry', async () => {
    const records = [makeRecord(0), makeRecord(1)];
    const client = {
      GET: vi.fn().mockResolvedValue({ data: { items: records, total: 2 }, response: { ok: true } }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.searchRecords('sword', ['weap']);

    expect(result.items).toEqual(records);
    expect(result.total).toBe(2);
    expect(client.GET).toHaveBeenCalledWith(
      '/records',
      expect.objectContaining({ params: { query: { search: 'sword', type: 'weap', limit: 20 } } }),
    );
  });

  it('omits type when validTypes is empty or has more than one entry', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ data: { items: [], total: 0 }, response: { ok: true } }),
    } as any;
    const repo = new ApiPluginRepository(client);

    await repo.searchRecords('kw', []);
    expect(client.GET).toHaveBeenLastCalledWith(
      '/records',
      expect.objectContaining({ params: { query: { search: 'kw', limit: 20 } } }),
    );

    await repo.searchRecords('kw', ['weap', 'armo']);
    expect(client.GET).toHaveBeenLastCalledWith(
      '/records',
      expect.objectContaining({ params: { query: { search: 'kw', limit: 20 } } }),
    );
  });

  it('returns empty result when data is undefined', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: undefined, response: { ok: true } }) } as any;
    const repo = new ApiPluginRepository(client);

    expect(await repo.searchRecords('kw', [])).toEqual({ items: [], total: 0 });
  });

  it('throws on a non-OK response', async () => {
    const repo = new ApiPluginRepository(nonOkClient());
    await expect(repo.searchRecords('kw', [])).rejects.toThrow(/500/);
  });
});

describe('ApiPluginRepository.setFilter', () => {
  it('calls POST /session/filter and returns null on success', async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({ response: { ok: true } }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const error = await repo.setFilter('SELECT form_key FROM "npc_"');

    expect(error).toBeNull();
    expect(client.POST).toHaveBeenCalledWith(
      '/session/filter',
      expect.objectContaining({ body: { sql: 'SELECT form_key FROM "npc_"' } }),
    );
  });

  it('returns error text when response is not ok', async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({
        error: 'Filter SQL must return a form_key column',
        response: {
          ok: false,
          text: () => Promise.reject(new TypeError('Body is unusable: Body has already been read')),
        },
      }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const error = await repo.setFilter('SELECT editor_id FROM "npc_"');

    expect(error).toBe('Filter SQL must return a form_key column');
  });
});

describe('ApiPluginRepository.clearFilter', () => {
  it('calls DELETE /session/filter', async () => {
    const client = {
      DELETE: vi.fn().mockResolvedValue({ response: { ok: true } }),
    } as any;
    const repo = new ApiPluginRepository(client);

    await repo.clearFilter();

    expect(client.DELETE).toHaveBeenCalledWith('/session/filter', expect.anything());
  });
});

describe('ApiPluginRepository.getActiveFilter', () => {
  it('calls GET /session/filter and returns sql', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: { sql: 'SELECT form_key FROM "npc_"' },
        response: { ok: true },
      }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const sql = await repo.getActiveFilter();

    expect(sql).toBe('SELECT form_key FROM "npc_"');
    expect(client.GET).toHaveBeenCalledWith('/session/filter', expect.anything());
  });

  it('returns null when sql is null', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ data: { sql: null }, response: { ok: true } }),
    } as any;
    const repo = new ApiPluginRepository(client);

    expect(await repo.getActiveFilter()).toBeNull();
  });

  it('throws on a non-OK response instead of resolving to null, so a failed read is never mistaken for "no filter set"', async () => {
    const repo = new ApiPluginRepository(nonOkClient());
    await expect(repo.getActiveFilter()).rejects.toThrow(/500/);
  });
});

// #307 / ADR-0035: what the session can honestly say about itself *while it is still loading* —
// polled alongside the in-flight load POST. `conflictsComputed` is read separately from `state`
// on purpose (SessionStatus.cs): the sweep is whole-set, so ADR-0035's live mutations will leave
// a Ready session with stale winners, and anything deciding whether to render conflict
// information must read that field, never the state.
describe('ApiPluginRepository.getSessionStatus', () => {
  it('calls GET /session/status and reports the plugins indexed so far, the sweep state and the failures', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: {
          state: 1,
          totalPlugins: 3,
          indexedPlugins: [{ name: 'Fallout4.esm', origin: 'Data' }, { name: 'TestMod.esp', origin: 'ModA' }],
          conflictsComputed: false,
          failures: [{ name: 'Bad.esp', reason: 'RACE parse' }],
        },
        response: { ok: true },
      }),
    } as any;

    const status = await new ApiPluginRepository(client).getSessionStatus();

    expect(status).toEqual({
      totalPlugins: 3,
      indexedPlugins: ['Fallout4.esm', 'TestMod.esp'],
      conflictsComputed: false,
      failures: [{ name: 'Bad.esp', reason: 'RACE parse' }],
    });
    expect(client.GET).toHaveBeenCalledWith('/session/status', expect.anything());
  });

  // The endpoint answers 200 in every state including "no session" (SessionEndpoints.cs), so a
  // non-ok here is a genuine fault. It must not degrade to a plausible-looking "nothing indexed,
  // conflicts not computed" — that reads as a load making no progress rather than a broken read,
  // and the caller (SessionController's poll loop) is the one that decides to tolerate it.
  it('throws on a non-OK response rather than degrading to an empty, still-loading-looking status', async () => {
    await expect(new ApiPluginRepository(nonOkClient()).getSessionStatus()).rejects.toThrow(/500/);
  });
});

// #417: polled the same way getTrackStatus/getSessionStatus are.
describe('ApiPluginRepository.getExternalChangeStatus', () => {
  it('calls GET /plugins/external-changes/status and maps every queued question', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: [
          { plugin: 'Fixture.esp', origin: 'ModA', metaChanged: true, oldVersion: '1.0', newVersion: '2.0' },
        ],
        response: { ok: true },
      }),
    } as any;

    const pending = await new ApiPluginRepository(client).getExternalChangeStatus();

    expect(pending).toEqual([
      { plugin: 'Fixture.esp', origin: 'ModA', metaChanged: true, oldVersion: '1.0', newVersion: '2.0' },
    ]);
    expect(client.GET).toHaveBeenCalledWith('/plugins/external-changes/status', expect.anything());
  });

  it('throws on a non-OK response rather than degrading to an empty queue', async () => {
    await expect(new ApiPluginRepository(nonOkClient()).getExternalChangeStatus()).rejects.toThrow(/500/);
  });
});

// Issue #211: the condition-function catalogue backing the extension-host QuickPick. Unlike most
// PluginRepository reads (ensureOk-then-throw), this mirrors the deleted webview-side
// RecordSessionClient.conditionFunctions()'s degrade-to-[] convention (closer precedent:
// setFilter/clearFilter's catch-and-log-no-throw above) — a failed fetch must never surface as a
// raw error, per #211's AC3.
describe('ApiPluginRepository.getConditionFunctions', () => {
  it('calls GET /condition-functions and returns the catalog on success', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ data: ['GetIsID', 'GetDistance'], response: { ok: true } }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const names = await repo.getConditionFunctions();

    expect(names).toEqual(['GetIsID', 'GetDistance']);
    expect(client.GET).toHaveBeenCalledWith('/condition-functions', expect.anything());
  });

  it('returns [] on a failed fetch instead of throwing', async () => {
    const repo = new ApiPluginRepository(nonOkClient());

    expect(await repo.getConditionFunctions()).toEqual([]);
  });
});

describe('ApiPluginRepository.getWorldspaces', () => {
  it('maps worldspace summaries on an OK response', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: [{ formKey: 'Fallout4.esm:00003C', editorId: 'Commonwealth' }],
        response: { ok: true },
      }),
    } as any;
    const repo = new ApiPluginRepository(client);

    expect(await repo.getWorldspaces('Plugin.esp')).toEqual([
      { formKey: 'Fallout4.esm:00003C', editorId: 'Commonwealth' },
    ]);
  });

  it('throws on a non-OK response so the tree can surface an error instead of an empty list', async () => {
    const repo = new ApiPluginRepository(nonOkClient());
    await expect(repo.getWorldspaces('Plugin.esp')).rejects.toThrow(/500/);
  });
});

describe('ApiPluginRepository.getWorldspaceBlocks', () => {
  it('maps the top cell and nested blocks/subBlocks/cells on an OK response', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: {
          topCell: { formKey: 'Fallout4.esm:000001', editorId: 'TopCell', cellX: null, cellY: null },
          blocks: [{
            x: 1,
            y: -1,
            subBlocks: [{
              x: 2,
              y: -2,
              cells: [{ formKey: 'Fallout4.esm:000002', editorId: 'Cell2', cellX: 12, cellY: -5 }],
            }],
          }],
        },
        response: { ok: true },
      }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getWorldspaceBlocks('Plugin.esp', 'Fallout4.esm:00003C');

    expect(result).toEqual({
      topCell: { formKey: 'Fallout4.esm:000001', editorId: 'TopCell', cellX: null, cellY: null },
      blocks: [{
        x: 1,
        y: -1,
        subBlocks: [{
          x: 2,
          y: -2,
          cells: [{ formKey: 'Fallout4.esm:000002', editorId: 'Cell2', cellX: 12, cellY: -5 }],
        }],
      }],
    });
    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/worldspaces/{formKey}/blocks',
      expect.objectContaining({ params: { path: { plugin: 'Plugin.esp', formKey: 'Fallout4.esm:00003C' }, query: {} } }),
    );
  });

  it('throws on a non-OK response so the tree can surface an error instead of an empty list', async () => {
    const repo = new ApiPluginRepository(nonOkClient());
    await expect(repo.getWorldspaceBlocks('Plugin.esp', 'Fallout4.esm:00003C')).rejects.toThrow(/500/);
  });
});

describe('ApiPluginRepository.getCellReferences', () => {
  it('maps persistent and temporary placed summaries on an OK response', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: {
          persistent: [{ formKey: 'Fallout4.esm:000010', editorId: 'PersistentRef', baseFormKey: 'Fallout4.esm:000011', recordType: 'refr' }],
          temporary: [{ formKey: 'Fallout4.esm:000020', editorId: 'TempRef', baseFormKey: null, recordType: 'achr' }],
        },
        response: { ok: true },
      }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getCellReferences('Plugin.esp', 'Fallout4.esm:00003C');

    expect(result).toEqual({
      persistent: [{ formKey: 'Fallout4.esm:000010', editorId: 'PersistentRef', baseFormKey: 'Fallout4.esm:000011', recordType: 'refr' }],
      temporary: [{ formKey: 'Fallout4.esm:000020', editorId: 'TempRef', baseFormKey: null, recordType: 'achr' }],
    });
    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/cells/{formKey}/references',
      expect.objectContaining({ params: { path: { plugin: 'Plugin.esp', formKey: 'Fallout4.esm:00003C' }, query: {} } }),
    );
  });

  it('throws on a non-OK response so the tree can surface an error instead of an empty list', async () => {
    const repo = new ApiPluginRepository(nonOkClient());
    await expect(repo.getCellReferences('Plugin.esp', 'Fallout4.esm:00003C')).rejects.toThrow(/500/);
  });
});

describe('ApiPluginRepository.getInteriorCells', () => {
  it('calls GET /plugins/{plugin}/interior-cells with query params and maps items/total', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: {
          items: [{ formKey: 'Fallout4.esm:000030', editorId: 'IntCell', cellX: null, cellY: null }],
          total: 42,
        },
        response: { ok: true },
      }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getInteriorCells('Plugin.esp', 50, 25);

    expect(result).toEqual({
      items: [{ formKey: 'Fallout4.esm:000030', editorId: 'IntCell', cellX: null, cellY: null }],
      total: 42,
    });
    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/interior-cells',
      expect.objectContaining({ params: { path: { plugin: 'Plugin.esp' }, query: { offset: 50, limit: 25 } } }),
    );
  });

  it('throws on a non-OK response so the tree can surface an error instead of an empty list', async () => {
    const repo = new ApiPluginRepository(nonOkClient());
    await expect(repo.getInteriorCells('Plugin.esp', 0, 50)).rejects.toThrow(/500/);
  });
});

// #34 / ADR-0036: a row that stands for a specific copy of a filename says which one; an ordinary
// load-order row sends no origin at all and lets the backend resolve it.
describe('ApiPluginRepository origin threading', () => {
  it('sends origin as a query param on getRecordTypes', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: [], response: { ok: true } }) } as any;

    await new ApiPluginRepository(client).getRecordTypes('Shared.esp', 'ModB');

    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/record-types',
      expect.objectContaining({ params: { path: { plugin: 'Shared.esp' }, query: { origin: 'ModB' } } }),
    );
  });

  it('sends origin as a query param on getRecords', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], total: 0 }, response: { ok: true } }) } as any;

    await new ApiPluginRepository(client).getRecords('Shared.esp', 'WEAP', 0, 50, 'ModB');

    expect(client.GET).toHaveBeenCalledWith(
      '/records',
      expect.objectContaining({ params: { query: expect.objectContaining({ plugin: 'Shared.esp', origin: 'ModB' }) } }),
    );
  });

  it('omits origin entirely when none is given', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], total: 0 }, response: { ok: true } }) } as any;

    await new ApiPluginRepository(client).getRecords('Plugin0.esp', 'WEAP', 0, 50);

    expect(client.GET.mock.calls[0][1].params.query).not.toHaveProperty('origin');
  });

  // #305: the spatial routes get the same treatment the record routes already have — a tree row
  // that knows which copy it stands for states it; an ordinary load-order row sends none.
  it('sends origin as a query param on getWorldspaces', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: [], response: { ok: true } }) } as any;

    await new ApiPluginRepository(client).getWorldspaces('Shared.esp', 'ModB');

    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/worldspaces',
      expect.objectContaining({ params: { path: { plugin: 'Shared.esp' }, query: { origin: 'ModB' } } }),
    );
  });

  it('sends origin as a query param on getWorldspaceBlocks', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { blocks: [], topCell: null }, response: { ok: true } }) } as any;

    await new ApiPluginRepository(client).getWorldspaceBlocks('Shared.esp', 'Fallout4.esm:00003C', 'ModB');

    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/worldspaces/{formKey}/blocks',
      expect.objectContaining({
        params: { path: { plugin: 'Shared.esp', formKey: 'Fallout4.esm:00003C' }, query: { origin: 'ModB' } },
      }),
    );
  });

  it('sends origin as a query param on getCellReferences', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { persistent: [], temporary: [] }, response: { ok: true } }) } as any;

    await new ApiPluginRepository(client).getCellReferences('Shared.esp', 'Fallout4.esm:00003C', 'ModB');

    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/cells/{formKey}/references',
      expect.objectContaining({
        params: { path: { plugin: 'Shared.esp', formKey: 'Fallout4.esm:00003C' }, query: { origin: 'ModB' } },
      }),
    );
  });

  it('sends origin as a query param on getInteriorCells', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], total: 0 }, response: { ok: true } }) } as any;

    await new ApiPluginRepository(client).getInteriorCells('Shared.esp', 0, 50, 'ModB');

    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/interior-cells',
      expect.objectContaining({
        params: { path: { plugin: 'Shared.esp' }, query: { offset: 0, limit: 50, origin: 'ModB' } },
      }),
    );
  });

  it('omits origin entirely on the spatial routes when none is given', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: [], response: { ok: true } }) } as any;

    await new ApiPluginRepository(client).getWorldspaces('Plugin0.esp');

    expect(client.GET.mock.calls[0][1].params.query).not.toHaveProperty('origin');
  });
});
