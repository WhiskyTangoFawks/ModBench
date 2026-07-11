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
        response: { ok: false, status: 503, text: () => Promise.resolve('No session loaded.') },
      }),
    } as any;
    const repo = new ApiPluginRepository(client);

    await expect(repo.getPlugins()).rejects.toThrow(/503/);
  });
});

describe('ApiPluginRepository.getRecordTypes', () => {
  it('calls GET /plugins/{plugin}/record-types with correct path param', async () => {
    const types = [{ type: 'WEAP', count: 42 }, { type: 'NPC_', count: 10 }];
    const client = { GET: vi.fn().mockResolvedValue({ data: types }) } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getRecordTypes('MyPlugin.esp');

    expect(result).toEqual(types);
    expect(client.GET).toHaveBeenCalledWith(
      '/plugins/{plugin}/record-types',
      expect.objectContaining({ params: { path: { plugin: 'MyPlugin.esp' } } }),
    );
  });

  it('returns empty array when data is undefined', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: undefined }) } as any;
    const repo = new ApiPluginRepository(client);

    expect(await repo.getRecordTypes('Plugin.esp')).toEqual([]);
  });
});

describe('ApiPluginRepository.getRecords', () => {
  it('calls GET /records with correct query params', async () => {
    const records = [makeRecord(0), makeRecord(1)];
    const client = {
      GET: vi.fn().mockResolvedValue({ data: { items: records, total: 100 } }),
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
    const client = { GET: vi.fn().mockResolvedValue({ data: undefined }) } as any;
    const repo = new ApiPluginRepository(client);

    const result = await repo.getRecords('Plugin.esp', 'WEAP', 0, 50);

    expect(result).toEqual({ items: [], total: 0 });
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
        response: { ok: false, text: () => Promise.resolve('Filter SQL must return a form_key column') },
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
      GET: vi.fn().mockResolvedValue({ data: { sql: 'SELECT form_key FROM "npc_"' } }),
    } as any;
    const repo = new ApiPluginRepository(client);

    const sql = await repo.getActiveFilter();

    expect(sql).toBe('SELECT form_key FROM "npc_"');
    expect(client.GET).toHaveBeenCalledWith('/session/filter', expect.anything());
  });

  it('returns null when sql is null', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ data: { sql: null } }),
    } as any;
    const repo = new ApiPluginRepository(client);

    expect(await repo.getActiveFilter()).toBeNull();
  });
});
