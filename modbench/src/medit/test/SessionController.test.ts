import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionController, type SessionControllerDeps } from '../SessionController';
import type { PluginMetadata } from '../ApiClient';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Mimics a real non-ok openapi-fetch result: `error` is already parsed from the
 *  body, and the underlying Response's body stream is drained — a second
 *  `response.text()` call throws, just like real `fetch`. Production code must
 *  read `error`, not re-read the body (see the `launchMedit` "Body is unusable" bug). */
function drainedError(status: number, error: string) {
  return {
    error,
    response: {
      ok: false,
      status,
      text: () => Promise.reject(new TypeError('Body is unusable: Body has already been read')),
    },
  };
}

function makePlugins(count: number): PluginMetadata[] {
  return Array.from({ length: count }, (_, i) => ({
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
  }));
}

function makeClient({
  plugins = makePlugins(2),
  createPluginOk = true,
  copyRecordOk = true,
  createRecordOk = true,
}: {
  plugins?: PluginMetadata[];
  createPluginOk?: boolean;
  copyRecordOk?: boolean;
  createRecordOk?: boolean;
} = {}) {
  return {
    GET: vi.fn().mockResolvedValue({ data: plugins, response: { ok: true } }),
    POST: vi.fn().mockImplementation((path: string) => {
      if (path === '/plugins/create') {
        return Promise.resolve(
          createPluginOk
            ? { response: { ok: true, status: 200 }, data: { name: 'test.esp' } }
            : drainedError(400, 'Bad Request'),
        );
      }
      if (path === '/records/{formKey}/copy-to/{targetPlugin}') {
        return Promise.resolve(copyRecordOk ? { response: { ok: true, status: 200 } } : drainedError(400, 'Copy failed'));
      }
      if (path === '/plugins/{plugin}/records') {
        return Promise.resolve(
          createRecordOk
            ? { response: { ok: true, status: 200 }, data: { formKey: '000801:MyPatch.esp', groupId: 'g1' } }
            : drainedError(422, 'Copy failed'),
        );
      }
      return Promise.resolve({ response: { ok: true } });
    }),
  } as any;
}

function makeRepository({
  setFilterError = null as string | null,
  activeFilter = null as string | null,
  plugins = [] as PluginMetadata[],
} = {}) {
  return {
    setFilter: vi.fn().mockResolvedValue(setFilterError),
    clearFilter: vi.fn().mockResolvedValue(undefined),
    getActiveFilter: vi.fn().mockResolvedValue(activeFilter),
    getPlugins: vi.fn().mockResolvedValue(plugins),
    getRecordTypes: vi.fn().mockResolvedValue([]),
    getRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as any;
}

function makeDeps(overrides: Partial<SessionControllerDeps> = {}): SessionControllerDeps {
  return {
    client: makeClient(),
    repository: makeRepository(),
    refreshTree: vi.fn(),
    refreshGroupTree: vi.fn(),
    setStatusText: vi.fn(),
    showWarning: vi.fn(),
    showError: vi.fn(),
    setFilterActive: vi.fn(),
    ...overrides,
  };
}

// ── createPlugin ──────────────────────────────────────────────────────────────

describe('SessionController.createPlugin', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs to /plugins/create and refreshes tree on success', async () => {
    const deps = makeDeps();
    const ctrl = new SessionController(deps);

    await ctrl.createPlugin('MyPatch.esp');

    expect(deps.client.POST).toHaveBeenCalledWith(
      '/plugins/create',
      expect.objectContaining({ body: { name: 'MyPatch.esp' } }),
    );
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('shows error and does not refresh tree on failure', async () => {
    const deps = makeDeps({ client: makeClient({ createPluginOk: false }) });
    const ctrl = new SessionController(deps);

    await ctrl.createPlugin('MyPatch.esp');

    expect(deps.showError).toHaveBeenCalledOnce();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });
});

// ── copyRecordTo ──────────────────────────────────────────────────────────────

describe('SessionController.copyRecordTo', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs to copy-to endpoint with correct path params and refreshes tree', async () => {
    const deps = makeDeps();
    const ctrl = new SessionController(deps);

    await ctrl.copyRecordTo('Fallout4.esm:001234', 'MyPatch.esp');

    expect(deps.client.POST).toHaveBeenCalledWith(
      '/records/{formKey}/copy-to/{targetPlugin}',
      expect.objectContaining({
        params: { path: { formKey: 'Fallout4.esm:001234', targetPlugin: 'MyPatch.esp' } },
      }),
    );
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('shows error and does not refresh tree on failure', async () => {
    const deps = makeDeps({ client: makeClient({ copyRecordOk: false }) });
    const ctrl = new SessionController(deps);

    await ctrl.copyRecordTo('Fallout4.esm:001234', 'MyPatch.esp');

    expect(deps.showError).toHaveBeenCalledOnce();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  // #281: a tree-invoked Copy as Override names the clicked row's own copy — the backend copies
  // that version, not the winner (#202's column-header rule, now on every surface).
  it('forwards sourcePlugin/sourceOrigin in the body when given', async () => {
    const deps = makeDeps();
    const ctrl = new SessionController(deps);

    await ctrl.copyRecordTo('Fallout4.esm:001234', 'MyPatch.esp', 'Source.esp', 'ModA');

    expect(deps.client.POST).toHaveBeenCalledWith(
      '/records/{formKey}/copy-to/{targetPlugin}',
      expect.objectContaining({
        body: { sourcePlugin: 'Source.esp', sourceOrigin: 'ModA' },
      }),
    );
  });

  // #331 (bundled pre-existing bug fix): a tree-invoked copy stages a pending change same as a
  // webview-staged edit — the Pending Changes tree (and, since #331, the Plugins-tree decoration
  // provider) must hear about it too, not just the record tree.
  it('also refreshes the pending-change group tree on success', async () => {
    const deps = makeDeps();
    const ctrl = new SessionController(deps);

    await ctrl.copyRecordTo('Fallout4.esm:001234', 'MyPatch.esp');

    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
  });

  it('does not refresh the pending-change group tree on failure', async () => {
    const deps = makeDeps({ client: makeClient({ copyRecordOk: false }) });
    const ctrl = new SessionController(deps);

    await ctrl.copyRecordTo('Fallout4.esm:001234', 'MyPatch.esp');

    expect(deps.refreshGroupTree).not.toHaveBeenCalled();
  });
});

// ── copyAsNewRecord ───────────────────────────────────────────────────────────

// #281: Copy as New Record from a tree row — one backend call (template + source copy named),
// no open record panel required.
describe('SessionController.copyAsNewRecord', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs a create with the template-source triple and refreshes tree', async () => {
    const deps = makeDeps();
    const ctrl = new SessionController(deps);

    await ctrl.copyAsNewRecord('Fallout4.esm:001234', 'MyPatch.esp', 'Source.esp', 'ModA');

    expect(deps.client.POST).toHaveBeenCalledWith(
      '/plugins/{plugin}/records',
      expect.objectContaining({
        params: { path: { plugin: 'MyPatch.esp' } },
        body: {
          templateFormKey: 'Fallout4.esm:001234',
          templateSourcePlugin: 'Source.esp',
          templateSourceOrigin: 'ModA',
          source: 'user',
        },
      }),
    );
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('omits templateSourceOrigin when the row has none (load-order copy)', async () => {
    const deps = makeDeps();
    const ctrl = new SessionController(deps);

    await ctrl.copyAsNewRecord('Fallout4.esm:001234', 'MyPatch.esp', 'Source.esp');

    expect(deps.client.POST).toHaveBeenCalledWith(
      '/plugins/{plugin}/records',
      expect.objectContaining({
        body: {
          templateFormKey: 'Fallout4.esm:001234',
          templateSourcePlugin: 'Source.esp',
          source: 'user',
        },
      }),
    );
  });

  it('shows error and does not refresh tree on failure', async () => {
    const deps = makeDeps({ client: makeClient({ createRecordOk: false }) });
    const ctrl = new SessionController(deps);

    await ctrl.copyAsNewRecord('Fallout4.esm:001234', 'MyPatch.esp', 'Source.esp');

    expect(deps.showError).toHaveBeenCalledOnce();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  // #331 (bundled pre-existing bug fix): stages a `create` change — see SessionController.copyRecordTo's own test above.
  it('also refreshes the pending-change group tree on success', async () => {
    const deps = makeDeps();
    const ctrl = new SessionController(deps);

    await ctrl.copyAsNewRecord('Fallout4.esm:001234', 'MyPatch.esp', 'Source.esp');

    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
  });
});

// ── setFilter ─────────────────────────────────────────────────────────────────

describe('SessionController.setFilter', () => {
  beforeEach(() => vi.resetAllMocks());

  it('calls repository.setFilter and sets filter active + refreshes tree on success', async () => {
    const repository = makeRepository();
    const deps = makeDeps({ repository });
    const ctrl = new SessionController(deps);

    const ok = await ctrl.setFilter('SELECT form_key FROM "npc_"');

    expect(ok).toBe(true);
    expect(repository.setFilter).toHaveBeenCalledWith('SELECT form_key FROM "npc_"');
    expect(deps.setFilterActive).toHaveBeenCalledWith(true, 'SELECT form_key FROM "npc_"');
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('shows error and returns false when repository returns an error message', async () => {
    const repository = makeRepository({ setFilterError: 'Filter SQL must return a form_key column' });
    const deps = makeDeps({ repository });
    const ctrl = new SessionController(deps);

    const ok = await ctrl.setFilter('SELECT editor_id FROM "npc_"');

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('form_key'));
    expect(deps.setFilterActive).not.toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });
});

// ── clearFilter ───────────────────────────────────────────────────────────────

describe('SessionController.clearFilter', () => {
  beforeEach(() => vi.resetAllMocks());

  it('calls repository.clearFilter and sets filter inactive + refreshes tree', async () => {
    const repository = makeRepository();
    const deps = makeDeps({ repository });
    const ctrl = new SessionController(deps);

    await ctrl.clearFilter();

    expect(repository.clearFilter).toHaveBeenCalledOnce();
    expect(deps.setFilterActive).toHaveBeenCalledWith(false);
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });
});

// ── syncFilterState ───────────────────────────────────────────────────────────

describe('SessionController.syncFilterState', () => {
  beforeEach(() => vi.resetAllMocks());

  it('sets filter active true when a filter is returned', async () => {
    const repository = makeRepository({ activeFilter: 'SELECT form_key FROM "npc_"' });
    const deps = makeDeps({ repository });
    const ctrl = new SessionController(deps);

    await ctrl.syncFilterState();

    expect(deps.setFilterActive).toHaveBeenCalledWith(true, 'SELECT form_key FROM "npc_"');
  });

  it('sets filter active false when no filter is returned', async () => {
    const repository = makeRepository({ activeFilter: null });
    const deps = makeDeps({ repository });
    const ctrl = new SessionController(deps);

    await ctrl.syncFilterState();

    expect(deps.setFilterActive).toHaveBeenCalledWith(false, undefined);
  });

  it('degrades to inactive and warns, without throwing, when the read fails', async () => {
    const repository = makeRepository();
    repository.getActiveFilter = vi.fn().mockRejectedValue(new Error('getActiveFilter failed (500): boom'));
    const deps = makeDeps({ repository });
    const ctrl = new SessionController(deps);

    await expect(ctrl.syncFilterState()).resolves.toBeUndefined();

    expect(deps.setFilterActive).toHaveBeenCalledWith(false);
    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('filter'));
  });
});

// ── saveGroup ─────────────────────────────────────────────────────────────────

describe('SessionController.saveGroup', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs to save endpoint and refreshes both trees on success', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({ response: { ok: true, status: 200 } }),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroup('abc-123');

    expect(client.POST).toHaveBeenCalledWith(
      '/change-groups/{groupId}/save',
      expect.objectContaining({ params: { path: { groupId: 'abc-123' } } }),
    );
    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('treats 404 as success and refreshes both trees', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue(drainedError(404, 'Not found')),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroup('abc-123');

    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('shows error on 409 and does not refresh', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue(drainedError(409, 'immutable')),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroup('abc-123');

    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('immutable'));
    expect(deps.refreshGroupTree).not.toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });
});

// ── revertGroup ───────────────────────────────────────────────────────────────

describe('SessionController.revertGroup', () => {
  beforeEach(() => vi.resetAllMocks());

  it('DELETEs the group and refreshes group tree only on success', async () => {
    const client = {
      ...makeClient(),
      DELETE: vi.fn().mockResolvedValue({ response: { ok: true, status: 204 } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.revertGroup('abc-123');

    expect(client.DELETE).toHaveBeenCalledWith(
      '/changes/group/{groupId}',
      expect.objectContaining({ params: { path: { groupId: 'abc-123' } } }),
    );
    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('shows error on failure and does not refresh', async () => {
    const client = {
      ...makeClient(),
      DELETE: vi.fn().mockResolvedValue(drainedError(500, 'server error')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.revertGroup('abc-123');

    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('server error'));
    expect(deps.refreshGroupTree).not.toHaveBeenCalled();
  });
});

// ── saveAllGroups ─────────────────────────────────────────────────────────────

describe('SessionController.saveAllGroups', () => {
  beforeEach(() => vi.resetAllMocks());

  it('fetches groups from backend, saves each sequentially, and refreshes both trees', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ data: [{ id: 'g1' }, { id: 'g2' }], response: { ok: true } }),
      POST: vi.fn().mockResolvedValue({ response: { ok: true, status: 200 } }),
      DELETE: vi.fn(),
    } as any;
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveAllGroups();

    expect(client.POST).toHaveBeenCalledTimes(2);
    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('shows error naming failed groups when one save fails', async () => {
    let postCalls = 0;
    const client = {
      GET: vi.fn().mockResolvedValue({ data: [{ id: 'g1' }, { id: 'g2' }], response: { ok: true } }),
      POST: vi.fn().mockImplementation(() => {
        postCalls++;
        if (postCalls === 2) return Promise.resolve(drainedError(500, 'disk full'));
        return Promise.resolve({ response: { ok: true, status: 200 } });
      }),
      DELETE: vi.fn(),
    } as any;
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveAllGroups();

    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('g2'));
  });

  it('does nothing when backend returns no groups', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ data: [], response: { ok: true } }),
      POST: vi.fn(),
      DELETE: vi.fn(),
    } as any;
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveAllGroups();

    expect(client.POST).not.toHaveBeenCalled();
    expect(deps.refreshGroupTree).not.toHaveBeenCalled();
  });

  it('shows error and does not save when GET /change-groups fails', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ response: { ok: false, status: 500 } }),
      POST: vi.fn(),
      DELETE: vi.fn(),
    } as any;
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveAllGroups();

    expect(deps.showError).toHaveBeenCalledOnce();
    expect(client.POST).not.toHaveBeenCalled();
  });
});

// ── saveGroups (multi-select) ──────────────────────────────────────────────────

describe('SessionController.saveGroups', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the per-group endpoint for each selected id and refreshes both trees', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({ data: {}, response: { ok: true, status: 200 } }),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroups(['id1', 'id2']);

    expect(client.POST).toHaveBeenCalledTimes(2);
    expect(client.POST).toHaveBeenCalledWith(
      '/change-groups/{groupId}/save',
      expect.objectContaining({ params: { path: { groupId: 'id1' } } }),
    );
    expect(client.POST).toHaveBeenCalledWith(
      '/change-groups/{groupId}/save',
      expect.objectContaining({ params: { path: { groupId: 'id2' } } }),
    );
    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('does nothing when the selection is empty', async () => {
    const client = { ...makeClient(), POST: vi.fn(), DELETE: vi.fn() };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroups([]);

    expect(client.POST).not.toHaveBeenCalled();
  });

  it('aggregates failures naming failed groups while refreshing on any success', async () => {
    let postCalls = 0;
    const client = {
      ...makeClient(),
      POST: vi.fn().mockImplementation(() => {
        postCalls++;
        if (postCalls === 2) return Promise.resolve(drainedError(500, 'disk full'));
        return Promise.resolve({ data: {}, response: { ok: true, status: 200 } });
      }),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroups(['id1', 'id2']);

    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('id2'));
    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
  });

  it('surfaces the stale-index warning when a per-group save reindex fails', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({
        data: { byPlugin: {}, reindexFailure: { plugins: ['Mod.esp'], reason: 'locked' } },
        response: { ok: true, status: 200 },
      }),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroups(['id1']);

    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('stale'));
  });
});

// ── revertGroups (multi-select) ────────────────────────────────────────────────

describe('SessionController.revertGroups', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reverts every selected group, each on its own component', async () => {
    const client = {
      ...makeClient(),
      DELETE: vi.fn().mockResolvedValue({ response: { ok: true, status: 204 } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.revertGroups(['id1', 'id2']);

    expect(client.DELETE).toHaveBeenCalledTimes(2);
    expect(client.DELETE).toHaveBeenCalledWith(
      '/changes/group/{groupId}',
      expect.objectContaining({ params: { path: { groupId: 'id1' } } }),
    );
    expect(client.DELETE).toHaveBeenCalledWith(
      '/changes/group/{groupId}',
      expect.objectContaining({ params: { path: { groupId: 'id2' } } }),
    );
  });

  it('reports every failed revert in one aggregated message, not one per group', async () => {
    const client = {
      ...makeClient(),
      DELETE: vi.fn().mockResolvedValue(drainedError(500, 'err')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.revertGroups(['id1', 'id2']);

    expect(deps.showError).toHaveBeenCalledTimes(1);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('id1'));
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('id2'));
  });
});

// ── partial-save reporting (ADR-0026 integrity tier) ────────────────────────────

describe('SessionController partial-save reporting', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reports which plugins saved and which failed when a save partially succeeds on HTTP 200', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({
        data: {
          byPlugin: {
            'A.esp': { backupPath: '/b', applied: ['001:A.esp'], readOnly: [], notFound: [], createFailed: [] },
            'B.esp': { backupPath: '/b', applied: [], readOnly: ['002:B.esp'], notFound: [], createFailed: [] },
          },
          reindexFailure: null,
        },
        response: { ok: true, status: 200 },
      }),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroup('abc-123');

    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('A.esp'));
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('B.esp'));
    // The group stays visible with its re-queued changes — the tree still refreshes.
    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
  });

  it('reports a plugin that applied some records and failed others as partial, not wholly failed', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({
        data: {
          byPlugin: {
            'A.esp': { backupPath: '/b', applied: ['001:A.esp'], readOnly: ['002:A.esp'], notFound: [], createFailed: [] },
          },
          reindexFailure: null,
        },
        response: { ok: true, status: 200 },
      }),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroup('abc-123');

    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('partially wrote A.esp'));
    expect(deps.showError).not.toHaveBeenCalledWith(expect.stringContaining('could not write'));
  });

  it('stays silent when every plugin in the outcome applied cleanly', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({
        data: {
          byPlugin: { 'A.esp': { backupPath: '/b', applied: ['001:A.esp'], readOnly: [], notFound: [], createFailed: [] } },
          reindexFailure: null,
        },
        response: { ok: true, status: 200 },
      }),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroup('abc-123');

    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
  });

  // #127 — a committed save whose post-commit reindex failed is an integrity-tier condition:
  // the write happened, but the record views are now stale. Surface it, never silently.
  it('warns that the index is stale (not "save failed") when the response names a reindex failure', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({
        data: {
          byPlugin: { 'A.esp': { backupPath: '/b', applied: ['001:A.esp'], readOnly: [], notFound: [], createFailed: [] } },
          reindexFailure: { plugins: ['A.esp'], reason: 'duckdb busy' },
        },
        response: { ok: true, status: 200 },
      }),
      DELETE: vi.fn(),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.saveGroup('abc-123');

    // Integrity-tier: a warning naming the stale plugin and telling the user to reload — not showError "Save failed".
    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('A.esp'));
    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringMatching(/stale|reload/i));
    expect(deps.showError).not.toHaveBeenCalledWith(expect.stringContaining('Save failed'));
    // The save still happened — the trees refresh so the pending change leaves the tree.
    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
  });
});

// ── revertAllGroups ───────────────────────────────────────────────────────────

describe('SessionController.revertAllGroups', () => {
  beforeEach(() => vi.resetAllMocks());

  it('fetches groups from backend and reverts each sequentially', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ data: [{ id: 'g1' }, { id: 'g2' }], response: { ok: true } }),
      DELETE: vi.fn().mockResolvedValue({ response: { ok: true, status: 204 } }),
    } as any;
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.revertAllGroups();

    expect(client.DELETE).toHaveBeenCalledTimes(2);
    expect(deps.refreshGroupTree).toHaveBeenCalledTimes(2);
  });

  it('shows error and does not revert when GET /change-groups fails', async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ response: { ok: false, status: 500 } }),
      DELETE: vi.fn(),
    } as any;
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.revertAllGroups();

    expect(deps.showError).toHaveBeenCalledOnce();
    expect(client.DELETE).not.toHaveBeenCalled();
  });
});

// ── deleteRecords ─────────────────────────────────────────────────────────────

describe('SessionController.deleteRecords', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs to /records/delete and refreshes tree on success', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({ response: { ok: true, status: 200 } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    const ok = await ctrl.deleteRecords([{ formKey: '000001:Test.esp', plugin: 'Test.esp' }]);

    expect(ok).toBe(true);
    expect(client.POST).toHaveBeenCalledWith('/records/delete', expect.objectContaining({
      body: { records: [{ formKey: '000001:Test.esp', plugin: 'Test.esp' }] },
    }));
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('shows error and returns false on 409 conflict', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue(drainedError(409, 'blocked')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    const ok = await ctrl.deleteRecords([{ formKey: '000001:Test.esp', plugin: 'Test.esp' }]);

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('blocked'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('shows error and returns false on network failure', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    const ok = await ctrl.deleteRecords([{ formKey: '000001:Test.esp', plugin: 'Test.esp' }]);

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  // #331 (bundled pre-existing bug fix): a staged delete (or reverted-create) is a pending-change
  // mutation — see SessionController.copyRecordTo's own test above.
  it('also refreshes the pending-change group tree on success', async () => {
    const client = { ...makeClient(), POST: vi.fn().mockResolvedValue({ response: { ok: true, status: 200 } }) };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.deleteRecords([{ formKey: '000001:Test.esp', plugin: 'Test.esp' }]);

    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
  });
});

// ── createPlaced ───────────────────────────────────────────────────────────────

describe('SessionController.createPlaced', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs to /plugins/{plugin}/cells/{cellFormKey}/placed and refreshes tree on success', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({ response: { ok: true, status: 200 } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.createPlaced('MyMod.esp', '000001A4:Fallout4.esm', 'refr', 'persistent');

    expect(client.POST).toHaveBeenCalledWith(
      '/plugins/{plugin}/cells/{cellFormKey}/placed',
      expect.objectContaining({
        params: { path: { plugin: 'MyMod.esp', cellFormKey: '000001A4:Fallout4.esm' } },
        body: expect.objectContaining({ recordType: 'refr', placementGroup: 'persistent' }),
      }),
    );
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('shows error on non-ok response', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue(drainedError(422, 'invalid type')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.createPlaced('MyMod.esp', '000001A4:Fallout4.esm', 'refr', 'persistent');

    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('invalid type'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('shows error on network failure', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.createPlaced('MyMod.esp', '000001A4:Fallout4.esm', 'refr', 'persistent');

    expect(deps.showError).toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  // #331 (bundled pre-existing bug fix): stages a `create` change — see SessionController.copyRecordTo's own test above.
  it('also refreshes the pending-change group tree on success', async () => {
    const client = { ...makeClient(), POST: vi.fn().mockResolvedValue({ response: { ok: true, status: 200 } }) };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.createPlaced('MyMod.esp', '000001A4:Fallout4.esm', 'refr', 'persistent');

    expect(deps.refreshGroupTree).toHaveBeenCalledOnce();
  });
});

// ── loadExplicitSession ───────────────────────────────────────────────────────

describe('SessionController.loadExplicitSession', () => {
  beforeEach(() => vi.resetAllMocks());

  const plugins = [
    { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', participates: true },
    { name: 'Fallout4.esm', path: '/game/Data/Fallout4.esm', origin: 'Data', participates: true },
  ];

  it('POSTs the ordered plugin list + dataFolder game directory and refreshes', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'loaded', failures: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.loadExplicitSession(plugins, '/game/Data');

    expect(deps.client.POST).toHaveBeenCalledWith(
      '/session/load-explicit',
      expect.objectContaining({ body: { plugins, gameDirectory: '/game/Data', gameRelease: 'Fallout4' } }),
    );
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('surfaces skipped-plugin failures as a warning (never silent)', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({
        response: { ok: true },
        data: { status: 'loaded', failures: [{ name: 'Lunar-UniqueCreatures.esp', reason: 'RACE parse' }] },
      }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.loadExplicitSession(plugins, '/game/Data');

    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('Lunar-UniqueCreatures.esp'));
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  // #277 / ADR-0037 AC7: the tree decoration needs the same failures the toast already
  // consumes — the caller reads them off the return value rather than a second read of state.
  it('resolves with the load-explicit failures so the caller can decorate the tree with them', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({
        response: { ok: true },
        data: { status: 'loaded', failures: [{ name: 'Bad.esp', reason: 'Malformed record' }] },
      }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    const failures = await ctrl.loadExplicitSession(plugins, '/game/Data');

    expect(failures).toEqual([{ name: 'Bad.esp', reason: 'Malformed record' }]);
  });

  it('resolves with an empty array when nothing failed to load', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'loaded', failures: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    const failures = await ctrl.loadExplicitSession(plugins, '/game/Data');

    expect(failures).toEqual([]);
  });

  it('warns when the active profile has zero enabled plugins (never silently empty)', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'loaded', failures: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.loadExplicitSession([], '/game/Data');

    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  // #270 / ADR-0035: every plugins.txt line is now sent, so a non-empty list no longer means the
  // profile has anything enabled. A load order where nothing participates indexes fine and wins
  // nothing — the same silently-empty conflict picture the zero-plugin warning exists to prevent.
  it('warns when plugins were sent but none of them participate', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'loaded', failures: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.loadExplicitSession(plugins.map(p => ({ ...p, participates: false })), '/game/Data');

    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  it('does not warn when at least one plugin participates', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'loaded', failures: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.loadExplicitSession([{ ...plugins[0], participates: false }, plugins[1]], '/game/Data');

    expect(deps.showWarning).not.toHaveBeenCalled();
  });

  it('shows an error and does not refresh when the load fails', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue(drainedError(400, 'bad dir')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await ctrl.loadExplicitSession(plugins, '/game/Data');

    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('bad dir'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  // #295 AC4: the caller (makeEnterEditing) tells a failed load apart from a load that
  // simply had nothing to report by the return value alone — `[]` is ambiguous with
  // "loaded, zero failures" and previously meant both. Backend-confirmed (SessionManager.
  // LoadExplicitCore disposes the old session unconditionally, before the new one can even
  // fail to build), so a failed POST really does mean "no session", not "the old one, stale".
  it('resolves undefined (not an empty array) when the load fails, so a failed load is never mistaken for zero failures', async () => {
    const client = {
      ...makeClient(),
      POST: vi.fn().mockResolvedValue(drainedError(400, 'bad dir')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    const failures = await ctrl.loadExplicitSession(plugins, '/game/Data');

    expect(failures).toBeUndefined();
  });
});

// ── hasPendingChanges ──────────────────────────────────────────────────────────

// #295: the live answer to "is there staged work right now", read fresh off the backend —
// not `modbench.hasPendingChanges` (a write-only VS Code context key; there is no API to read
// one back) and not the Pending Changes view's badge (a rendering side-effect of the same
// fetch, not something business logic should key off). Gates Reload Session's confirm.
describe('SessionController.hasPendingChanges', () => {
  beforeEach(() => vi.resetAllMocks());

  it('resolves true when the backend reports at least one change group', async () => {
    const client = {
      ...makeClient(),
      GET: vi.fn().mockResolvedValue({
        data: [{ id: 'g1', operation: 'edit', description: null, changeCount: 1, pluginCount: 1 }],
        response: { ok: true },
      }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await expect(ctrl.hasPendingChanges()).resolves.toBe(true);
  });

  it('resolves false when the backend reports no change groups', async () => {
    const client = {
      ...makeClient(),
      GET: vi.fn().mockResolvedValue({ data: [], response: { ok: true } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await expect(ctrl.hasPendingChanges()).resolves.toBe(false);
  });

  // Fail toward the confirm: a spurious modal costs one click, a silent discard of staged
  // work is unrecoverable — asymmetric costs, so an unreadable answer defaults to true.
  it('resolves true (assumes pending work) when the fetch fails', async () => {
    const client = {
      ...makeClient(),
      GET: vi.fn().mockResolvedValue(drainedError(500, 'boom')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await expect(ctrl.hasPendingChanges()).resolves.toBe(true);
  });

  it('resolves true (assumes pending work) when the fetch throws', async () => {
    const client = {
      ...makeClient(),
      GET: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const deps = makeDeps({ client });
    const ctrl = new SessionController(deps);

    await expect(ctrl.hasPendingChanges()).resolves.toBe(true);
  });
});
