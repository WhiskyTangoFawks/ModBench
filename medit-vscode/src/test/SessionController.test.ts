import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionController, type SessionControllerDeps } from '../SessionController';
import type { PluginMetadata } from '../ApiClient';
import type { SessionWizard } from '../SessionWizard';

// ── helpers ──────────────────────────────────────────────────────────────────

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
  }));
}

function makeClient({
  plugins = makePlugins(2),
  createPluginOk = true,
  copyRecordOk = true,
}: {
  plugins?: PluginMetadata[];
  createPluginOk?: boolean;
  copyRecordOk?: boolean;
} = {}) {
  return {
    GET: vi.fn().mockResolvedValue({ data: plugins, response: { ok: true } }),
    POST: vi.fn().mockImplementation((path: string) => {
      if (path === '/plugins/create') {
        return Promise.resolve({
          response: { ok: createPluginOk, status: createPluginOk ? 200 : 400, text: () => Promise.resolve('Bad Request') },
          data: createPluginOk ? { name: 'test.esp' } : undefined,
        });
      }
      if (path === '/records/{formKey}/copy-to/{targetPlugin}') {
        return Promise.resolve({
          response: { ok: copyRecordOk, status: copyRecordOk ? 200 : 400, text: () => Promise.resolve('Copy failed') },
        });
      }
      return Promise.resolve({ response: { ok: true } });
    }),
  } as any;
}

function makeWizardFactory(result: boolean): () => SessionWizard {
  return () => ({ run: vi.fn().mockResolvedValue(result) } as any);
}

function makeRepository({
  setFilterError = null as string | null,
  activeFilter = null as string | null,
} = {}) {
  return {
    setFilter: vi.fn().mockResolvedValue(setFilterError),
    clearFilter: vi.fn().mockResolvedValue(undefined),
    getActiveFilter: vi.fn().mockResolvedValue(activeFilter),
    getPlugins: vi.fn().mockResolvedValue([]),
    getRecordTypes: vi.fn().mockResolvedValue([]),
    getRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as any;
}

function makeDeps(overrides: Partial<SessionControllerDeps> = {}): SessionControllerDeps {
  return {
    client: makeClient(),
    makeWizard: makeWizardFactory(true),
    refreshTree: vi.fn(),
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
});

// ── getPlugins ────────────────────────────────────────────────────────────────

describe('SessionController.getPlugins', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns the typed plugin array from GET /plugins', async () => {
    const plugins = makePlugins(3);
    const deps = makeDeps({ client: makeClient({ plugins }) });
    const ctrl = new SessionController(deps);

    const result = await ctrl.getPlugins();

    expect(result).toEqual(plugins);
    expect(deps.client.GET).toHaveBeenCalledWith('/plugins', expect.anything());
  });
});

// ── loadSession ───────────────────────────────────────────────────────────────

describe('SessionController.loadSession', () => {
  beforeEach(() => vi.resetAllMocks());

  it('runs wizard and refreshes tree when wizard succeeds', async () => {
    const deps = makeDeps({ makeWizard: makeWizardFactory(true) });
    const ctrl = new SessionController(deps);

    await ctrl.loadSession();

    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.setStatusText).toHaveBeenCalledOnce();
  });

  it('does not refresh tree when wizard is cancelled', async () => {
    const deps = makeDeps({ makeWizard: makeWizardFactory(false) });
    const ctrl = new SessionController(deps);

    await ctrl.loadSession();

    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.setStatusText).not.toHaveBeenCalled();
  });
});

// ── onBackendConnected ────────────────────────────────────────────────────────

describe('SessionController.onBackendConnected', () => {
  beforeEach(() => vi.resetAllMocks());

  it('sets Ready status with plugin count and refreshes tree', async () => {
    const plugins = makePlugins(3);
    const deps = makeDeps({
      client: makeClient({ plugins }),
      makeWizard: makeWizardFactory(true),
    });
    const ctrl = new SessionController(deps);

    await ctrl.onBackendConnected();

    expect(deps.setStatusText).toHaveBeenCalledWith(expect.stringContaining('3'));
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showWarning).not.toHaveBeenCalled();
  });

  it('shows warning when no plugins are loaded', async () => {
    const deps = makeDeps({
      client: makeClient({ plugins: [] }),
      makeWizard: makeWizardFactory(true),
    });
    const ctrl = new SessionController(deps);

    await ctrl.onBackendConnected();

    expect(deps.showWarning).toHaveBeenCalledOnce();
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('sets No session status and refreshes tree when wizard fails', async () => {
    const deps = makeDeps({ makeWizard: makeWizardFactory(false) });
    const ctrl = new SessionController(deps);

    await ctrl.onBackendConnected();

    expect(deps.setStatusText).toHaveBeenCalledWith(expect.stringContaining('No session'));
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showWarning).not.toHaveBeenCalled();
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
      POST: vi.fn().mockResolvedValue({
        response: { ok: false, status: 409, text: () => Promise.resolve('blocked') },
      }),
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
});
