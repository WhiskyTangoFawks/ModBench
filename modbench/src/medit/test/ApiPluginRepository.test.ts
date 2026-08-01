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
      expect.objectContaining({ params: { path: { plugin: 'MyPlugin.esp' } } }),
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
      expect.objectContaining({ params: { path: { plugin: 'Plugin.esp', formKey: 'Fallout4.esm:00003C' } } }),
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
      expect.objectContaining({ params: { path: { plugin: 'Plugin.esp', formKey: 'Fallout4.esm:00003C' } } }),
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
