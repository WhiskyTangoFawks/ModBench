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
          response: { ok: createPluginOk, status: createPluginOk ? 200 : 400, text: async () => 'Bad Request' },
          data: createPluginOk ? { name: 'test.esp' } : undefined,
        });
      }
      if (path === '/records/{formKey}/copy-to/{targetPlugin}') {
        return Promise.resolve({
          response: { ok: copyRecordOk, status: copyRecordOk ? 200 : 400, text: async () => 'Copy failed' },
        });
      }
      return Promise.resolve({ response: { ok: true } });
    }),
  } as any;
}

function makeWizardFactory(result: boolean): () => SessionWizard {
  return () => ({ run: vi.fn().mockResolvedValue(result) } as any);
}

function makeDeps(overrides: Partial<SessionControllerDeps> = {}): SessionControllerDeps {
  return {
    client: makeClient(),
    makeWizard: makeWizardFactory(true),
    refreshTree: vi.fn(),
    setStatusText: vi.fn(),
    showWarning: vi.fn(),
    showError: vi.fn(),
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
