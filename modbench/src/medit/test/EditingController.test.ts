import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditingController, type EditingControllerDeps } from '../EditingController';
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
    enabled: true, winning: true, participates: true, inLoadOrder: true,
    origin: 'Data',
    masterIssues: [],
    hasMatchingRecords: true,
    isTracked: false,
  }));
}

function makeClient({
  plugins = makePlugins(2),
  createPluginOk = true,
  createRecordOk = true,
  deleteRecordOk = true,
  renumberRecordOk = true,
  copyAsOverrideOk = true,
  copyAsNewRecordOk = true,
}: {
  plugins?: PluginMetadata[];
  createPluginOk?: boolean;
  createRecordOk?: boolean;
  deleteRecordOk?: boolean;
  renumberRecordOk?: boolean;
  copyAsOverrideOk?: boolean;
  copyAsNewRecordOk?: boolean;
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
      // Create/delete/renumber — the wire shapes RecordEndpoints/PluginEndpoints actually
      // serve (RecordCreateResponse/RecordDeleteResponse/RecordRenumberResponse), not
      // retired-model shapes (e.g. `groupId`).
      if (path === '/plugins/{plugin}/records') {
        return Promise.resolve(
          createRecordOk
            ? { response: { ok: true, status: 200 }, data: { applied: true, formKey: '000801:MyPatch.esp', recordType: 'npc_' } }
            : drainedError(422, 'Unprocessable Content'),
        );
      }
      if (path === '/records/{formKey}/delete') {
        return Promise.resolve(
          deleteRecordOk
            ? { response: { ok: true, status: 200 }, data: { applied: true, formKey: '000801:MyPatch.esp' } }
            : drainedError(404, 'Not Found'),
        );
      }
      if (path === '/records/{formKey}/renumber') {
        return Promise.resolve(
          renumberRecordOk
            ? { response: { ok: true, status: 200 }, data: { applied: true, oldFormKey: '000801:MyPatch.esp', newFormKey: '000802:MyPatch.esp' } }
            : drainedError(422, 'Unprocessable Content'),
        );
      }
      // The two copy gestures' real wire shapes (RecordCopyAsOverrideResponse/
      // RecordCopyAsNewRecordResponse), not the retired /copy-to/{targetPlugin} endpoint
      // (RetiredEditingWireSurfaceTests.cs pins that route absent).
      if (path === '/records/{formKey}/copy-as-override') {
        return Promise.resolve(
          copyAsOverrideOk
            ? { response: { ok: true, status: 200 }, data: { applied: true, formKey: '000801:MyPatch.esp' } }
            : drainedError(422, 'Unprocessable Content'),
        );
      }
      if (path === '/records/{formKey}/copy-as-new-record') {
        return Promise.resolve(
          copyAsNewRecordOk
            ? { response: { ok: true, status: 200 }, data: { applied: true, sourceFormKey: '000801:MyPatch.esp', newFormKey: '000802:MyPatch.esp' } }
            : drainedError(422, 'Unprocessable Content'),
        );
      }
      return Promise.resolve({ response: { ok: true } });
    }),
    PUT: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } }),
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
    getLoadOrderStatus: vi.fn().mockResolvedValue(makeStatus()),
    getTrackStatus: vi.fn().mockResolvedValue({ phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }),
    getRecordTypes: vi.fn().mockResolvedValue([]),
    getRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as any;
}

/** One `GET /load-order/status` answer. Defaults describe a load that has done nothing yet,
 *  so a test states only the field it is about. */
function makeStatus({
  totalPlugins = 2,
  indexedPlugins = [] as string[],
  conflictsComputed = false,
  failures = [] as { name: string; reason: string }[],
} = {}) {
  return { totalPlugins, indexedPlugins, conflictsComputed, failures };
}

function makeDeps(overrides: Partial<EditingControllerDeps> = {}): EditingControllerDeps {
  return {
    client: makeClient(),
    repository: makeRepository(),
    refreshTree: vi.fn(),
    setStatusText: vi.fn(),
    showWarning: vi.fn(),
    showError: vi.fn(),
    setFilterActive: vi.fn(),
    refreshMatchingPlugins: vi.fn(),
    notifyConflictsComputed: vi.fn(),
    ...overrides,
  };
}

// ── createPlugin ──────────────────────────────────────────────────────────────

describe('EditingController.createPlugin', () => {
  beforeEach(() => vi.resetAllMocks());

  // The destination (path/origin) is the caller's — Mod Management's QuickPick, not an
  // implicit write into the Data folder — and the created plugin's own name comes back from the
  // response rather than being assumed, so the composition root's plugins.txt append names
  // whatever the backend actually wrote.
  it('POSTs to /plugins/create with the destination and returns the created plugin\'s name', async () => {
    const deps = makeDeps();
    const ctrl = new EditingController(deps);

    const result = await ctrl.createPlugin('MyPatch.esp', '/mods/MyMod', 'MyMod');

    expect(deps.client.POST).toHaveBeenCalledWith(
      '/plugins/create',
      expect.objectContaining({ body: { name: 'MyPatch.esp', path: '/mods/MyMod', origin: 'MyMod' } }),
    );
    expect(result).toEqual({ name: 'test.esp' });
  });

  // The tree must not refresh until the caller's
  // own plugins.txt append has also landed — refreshing here would show a plugin the load order
  // doesn't name yet — so refreshTree is strictly the composition root's call, never this
  // method's own.
  it('never refreshes the tree itself — that is the caller\'s job, after its own plugins.txt append', async () => {
    const deps = makeDeps();
    const ctrl = new EditingController(deps);

    await ctrl.createPlugin('MyPatch.esp', '/mods/MyMod', 'MyMod');

    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('shows error and returns undefined on failure', async () => {
    const deps = makeDeps({ client: makeClient({ createPluginOk: false }) });
    const ctrl = new EditingController(deps);

    const result = await ctrl.createPlugin('MyPatch.esp', '/mods/MyMod', 'MyMod');

    expect(deps.showError).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });
});

// ── copyRecordAsOverride / copyRecordAsNewRecord ──────────────────────────────

describe('EditingController.copyRecordAsOverride', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the source/destination plugin+origin and refreshes the tree', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const ok = await controller.copyRecordAsOverride('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA');

    expect(ok).toBe(true);
    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/copy-as-override', {
      params: { path: { formKey: '000801:Fallout4.esm' } },
      body: { sourcePlugin: 'Fallout4.esm', sourceOrigin: 'Data', destinationPlugin: 'MyPatch.esp', destinationOrigin: 'ModA' },
    });
    expect(deps.refreshTree).toHaveBeenCalled();
    // A copy lands as a working-tree change on the destination plugin's own source — same
    // reason createRecord/deleteRecord/renumberRecord refresh it.
    expect(deps.refreshMatchingPlugins).toHaveBeenCalled();
  });

  it('surfaces a refusal and reports that it did not happen', async () => {
    const client = makeClient({ copyAsOverrideOk: false });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const ok = await controller.copyRecordAsOverride('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA');

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('000801:Fallout4.esm'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('surfaces a thrown request the same way', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const ok = await controller.copyRecordAsOverride('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA');

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });
});

describe('EditingController.copyRecordAsNewRecord', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the source/destination plugin+origin with a null requestedFormKey, refreshes the tree, and returns the new FormKey', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const newFormKey = await controller.copyRecordAsNewRecord('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA');

    expect(newFormKey).toBe('000802:MyPatch.esp');
    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/copy-as-new-record', {
      params: { path: { formKey: '000801:Fallout4.esm' } },
      body: {
        sourcePlugin: 'Fallout4.esm', sourceOrigin: 'Data', destinationPlugin: 'MyPatch.esp', destinationOrigin: 'ModA',
        requestedFormKey: null,
      },
    });
    expect(deps.refreshTree).toHaveBeenCalled();
    // Same reason as copyRecordAsOverride above — a copy is a working-tree change too.
    expect(deps.refreshMatchingPlugins).toHaveBeenCalled();
  });

  it('passes an explicit requested FormKey through, xEdit\'s typed-FormID path', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    await controller.copyRecordAsNewRecord('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA', '000900:MyPatch.esp');

    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/copy-as-new-record', {
      params: { path: { formKey: '000801:Fallout4.esm' } },
      body: {
        sourcePlugin: 'Fallout4.esm', sourceOrigin: 'Data', destinationPlugin: 'MyPatch.esp', destinationOrigin: 'ModA',
        requestedFormKey: '000900:MyPatch.esp',
      },
    });
  });

  it('surfaces a refusal and reports that it did not happen', async () => {
    const client = makeClient({ copyAsNewRecordOk: false });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const newFormKey = await controller.copyRecordAsNewRecord('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA');

    expect(newFormKey).toBeUndefined();
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('000801:Fallout4.esm'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('surfaces a thrown request the same way', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const newFormKey = await controller.copyRecordAsNewRecord('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA');

    expect(newFormKey).toBeUndefined();
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });
});

// ── setFilter ─────────────────────────────────────────────────────────────────

describe('EditingController.setFilter', () => {
  beforeEach(() => vi.resetAllMocks());

  it('calls repository.setFilter and sets filter active + refreshes tree on success', async () => {
    const repository = makeRepository();
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    const ok = await ctrl.setFilter('SELECT form_key FROM "npc_"');

    expect(ok).toBe(true);
    expect(repository.setFilter).toHaveBeenCalledWith('SELECT form_key FROM "npc_"');
    expect(deps.setFilterActive).toHaveBeenCalledWith(true, 'SELECT form_key FROM "npc_"', undefined);
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  // ADR-0035 amending ADR-0018: a plugin's chevron depends on the filter's per-plugin
  // match set, which is only current as of the filter that produced it — a new filter has to
  // trigger a fresh derivation, or a chevron the old filter suppressed (or restored) would keep
  // stating the wrong thing about the new one.
  it('refreshes the plugin-match set on success', async () => {
    const deps = makeDeps({ repository: makeRepository() });
    const ctrl = new EditingController(deps);

    await ctrl.setFilter('SELECT form_key FROM "npc_"');

    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  // The Plugins tree's description names both narrowing axes, so the record filter has to
  // say *which* filter — raw SQL is unreadable as a readout, and "a filter is active" sends the
  // user back to the palette to find out which one.
  it('forwards the filter source label to the readout alongside the SQL', async () => {
    const deps = makeDeps({ repository: makeRepository() });
    const ctrl = new EditingController(deps);

    await ctrl.setFilter('SELECT form_key FROM "npc_"', 'npcs.sql');

    expect(deps.setFilterActive).toHaveBeenCalledWith(true, 'SELECT form_key FROM "npc_"', 'npcs.sql');
  });

  it('shows error and returns false when repository returns an error message', async () => {
    const repository = makeRepository({ setFilterError: 'Filter SQL must return a form_key column' });
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    const ok = await ctrl.setFilter('SELECT editor_id FROM "npc_"');

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('form_key'));
    expect(deps.setFilterActive).not.toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });
});

// ── clearFilter ───────────────────────────────────────────────────────────────

describe('EditingController.clearFilter', () => {
  beforeEach(() => vi.resetAllMocks());

  it('calls repository.clearFilter and sets filter inactive + refreshes tree', async () => {
    const repository = makeRepository();
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    await ctrl.clearFilter();

    expect(repository.clearFilter).toHaveBeenCalledOnce();
    expect(deps.setFilterActive).toHaveBeenCalledWith(false);
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  // ADR-0035 amending ADR-0018: a stale
  // `false` surviving past the filter that produced it would leave a plugin permanently
  // unexpandable even with nothing filtering it any more.
  it('refreshes the plugin-match set, so a stale no-match chevron does not survive the filter that produced it', async () => {
    const deps = makeDeps({ repository: makeRepository() });
    const ctrl = new EditingController(deps);

    await ctrl.clearFilter();

    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });
});

// ── syncFilterState ───────────────────────────────────────────────────────────

describe('EditingController.syncFilterState', () => {
  beforeEach(() => vi.resetAllMocks());

  it('sets filter active true when a filter is returned', async () => {
    const repository = makeRepository({ activeFilter: 'SELECT form_key FROM "npc_"' });
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    await ctrl.syncFilterState();

    expect(deps.setFilterActive).toHaveBeenCalledWith(true, 'SELECT form_key FROM "npc_"', undefined);
  });

  it('sets filter active false when no filter is returned', async () => {
    const repository = makeRepository({ activeFilter: null });
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    await ctrl.syncFilterState();

    expect(deps.setFilterActive).toHaveBeenCalledWith(false, undefined, undefined);
  });

  it('degrades to inactive and warns, without throwing, when the read fails', async () => {
    const repository = makeRepository();
    repository.getActiveFilter = vi.fn().mockRejectedValue(new Error('getActiveFilter failed (500): boom'));
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    await expect(ctrl.syncFilterState()).resolves.toBeUndefined();

    expect(deps.setFilterActive).toHaveBeenCalledWith(false);
    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('filter'));
  });
});

// ── saveGroup ─────────────────────────────────────────────────────────────────

// ── revertGroup ───────────────────────────────────────────────────────────────

// ── saveAllGroups ─────────────────────────────────────────────────────────────

// ── saveGroups (multi-select) ──────────────────────────────────────────────────

// ── revertGroups (multi-select) ────────────────────────────────────────────────

// ── partial-save reporting (ADR-0026 integrity tier) ────────────────────────────

// ── revertAllGroups ───────────────────────────────────────────────────────────

// ── deleteRecords ─────────────────────────────────────────────────────────────

// ── createPlaced ───────────────────────────────────────────────────────────────

// ── putLoadOrder ───────────────────────────────────────────────────────

describe('EditingController.putLoadOrder', () => {
  beforeEach(() => vi.resetAllMocks());

  const plugins = [
    { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true },
    { name: 'Fallout4.esm', path: '/game/Data/Fallout4.esm', origin: 'Data', slot: 1, enabled: true, winning: true },
  ];

  it('PUTs the ordered plugin list + dataFolder game directory + MO2 instance root and refreshes', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    await ctrl.putLoadOrder(plugins, '/game/Data', '/instance');

    expect(deps.client.PUT).toHaveBeenCalledWith(
      '/load-order',
      expect.objectContaining({
        // ADR-0001: instanceRoot is what the backend keys its persistent index on — omitting
        // it would let two MO2 instances with same-named mod folders read each other's records.
        body: { plugins, gameDirectory: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4' },
      }),
    );
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  // ADR-0035: reaching this method at all means the load PUT — which the backend only
  // answers after the winner sweep — resolved successfully, so this is the one reliable,
  // already-existing point at which conflicts become computed. Record panels open mid-load learn
  // this to refetch their own settled comparison (RecordPanel's CONFLICTS_COMPUTED
  // handler); no poller is added for it — the tick stream stops before/at this same transition.
  it('notifies that conflicts are computed on a successful load', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    await ctrl.putLoadOrder(plugins, '/game/Data', '/instance');

    expect(deps.notifyConflictsComputed).toHaveBeenCalledOnce();
  });

  it('surfaces skipped-plugin failures as a warning (never silent)', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({
        response: { ok: true },
        data: { status: 'reconciled', failures: [{ name: 'Lunar-UniqueCreatures.esp', reason: 'RACE parse' }], crashRepairOffers: [] },
      }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    await ctrl.putLoadOrder(plugins, '/game/Data', '/instance');

    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('Lunar-UniqueCreatures.esp'));
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  // ADR-0037 AC7: the tree decoration needs the same failures the toast already
  // consumes — the caller reads them off the return value rather than a second read of state.
  it('resolves with the reconcile failures so the caller can decorate the tree with them', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({
        response: { ok: true },
        data: { status: 'reconciled', failures: [{ name: 'Bad.esp', reason: 'Malformed record' }], crashRepairOffers: [] },
      }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance');

    // A tagged outcome, not a bare array — three outcomes (loaded / failed / abandoned)
    // need three answers, and a second sentinel would be one every call site has to remember.
    expect(result).toEqual({
      outcome: 'reconciled', failures: [{ name: 'Bad.esp', reason: 'Malformed record' }], crashRepairOffers: [],
    });
  });

  it('resolves with an empty array when nothing failed to load', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance');

    // Still distinguishable from a failed load — by the outcome tag rather than by
    // `[]` versus `undefined`.
    expect(result).toEqual({ outcome: 'reconciled', failures: [], crashRepairOffers: [] });
  });

  // crashRepairOffers rides the same response failures already does — the caller (extension.ts)
  // reads them off the return value to run the repair-offer dialog, never a second fetch.
  it('resolves with the crash-repair offers the load-order response carried, string reason trusted over the generated numeric type', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({
        response: { ok: true },
        data: {
          status: 'reconciled', failures: [],
          crashRepairOffers: [{ plugin: 'Foo.esp', origin: 'A', reason: 'InterruptedCompile' }],
        },
      }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance');

    expect(result).toEqual({
      outcome: 'reconciled', failures: [],
      crashRepairOffers: [{ plugin: 'Foo.esp', origin: 'A', reason: 'InterruptedCompile' }],
    });
  });

  it('warns when the active profile has zero enabled plugins (never silently empty)', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    await ctrl.putLoadOrder([], '/game/Data', '/instance');

    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  // ADR-0044: every copy is sent, so a non-empty snapshot no longer means the profile has anything
  // enabled — participation is enabled AND winning AND listed, derived. A snapshot where nothing
  // participates reconciles fine and wins nothing — the same silently-empty conflict picture the
  // zero-plugin warning exists to prevent.
  it('warns when plugins were sent but none of them participate', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    await ctrl.putLoadOrder(plugins.map(p => ({ ...p, enabled: false })), '/game/Data', '/instance');

    expect(deps.showWarning).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  it('does not warn when at least one plugin participates', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    await ctrl.putLoadOrder([{ ...plugins[0], enabled: false }, plugins[1]], '/game/Data', '/instance');

    expect(deps.showWarning).not.toHaveBeenCalled();
  });

  it('shows an error and does not refresh when the load fails', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue(drainedError(400, 'bad dir')),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    await ctrl.putLoadOrder(plugins, '/game/Data', '/instance');

    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('bad dir'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  // ADR-0001 point 6: another window holds this instance's index. The backend answers 423
  // with a ProblemDetails whose `detail` is the sentence for the user; that sentence — not the
  // JSON around it — is what the toast says, and the load is a plain failure: no retry, no wait.
  it('tells the user which cause refused the load when another window holds the instance (423)', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({
        error: {
          type: 'https://tools.ietf.org/html/rfc9110#section-15.5.24',
          title: 'Locked',
          status: 423,
          detail: "This instance's index is open in another Modbench window (/instance/modbench/index.duckdb).",
        },
        response: { ok: false, status: 423, text: () => Promise.reject(new TypeError('Body is unusable')) },
      }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance');

    expect(result).toEqual({ outcome: 'failed' });
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('open in another Modbench window'));
    expect(deps.showError).not.toHaveBeenCalledWith(expect.stringContaining('"status"'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  // The caller (makeEnterEditing) tells a failed load apart from a load that
  // simply had nothing to report by the return value alone — `[]` would be ambiguous with
  // "loaded, zero failures". Backend-confirmed (LoadOrderManager.
  // LoadExplicitCore disposes the old load order unconditionally, before the new one can even
  // fail to build), so a failed PUT really does mean "no load order", not "the old one, stale".
  it('reports a failed load as failed, so it is never mistaken for a load with zero failures', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue(drainedError(400, 'bad dir')),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance');

    // The `failed` tag leaves room for the third outcome.
    // ADR-0044: the backend tore nothing down — it
    // still holds what it held — so the caller leaves the view alone rather than exiting.
    expect(result).toEqual({ outcome: 'failed' });
    // Nothing settled, so nothing to notify — there is no fresher comparison for an open
    // panel to refetch.
    expect(deps.notifyConflictsComputed).not.toHaveBeenCalled();
  });
});

// ── putLoadOrder: progressive load (ADR-0035) ───────────────────

// The load PUT stays blocking, and the generated openapi-fetch client
// has no streaming path — so progress is polled off GET /load-order/status *alongside* the still
// in-flight PUT. This is the seam the polling logic is tested at: no VS Code types, a fake
// client and a fake repository, fake timers for the cadence.
describe('EditingController.putLoadOrder progress polling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const plugins = [
    { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true },
    { name: 'Fallout4.esm', path: '/game/Data/Fallout4.esm', origin: 'Data', slot: 1, enabled: true, winning: true },
  ];

  /** A load PUT that stays in flight until the returned `finish` is called — the whole point of
   *  this suite is what happens *during* that window, which a resolved mock cannot express. */
  function heldLoad() {
    let finish!: () => void;
    const held = new Promise((resolve) => {
      finish = () => resolve({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } });
    });
    return { PUT: vi.fn().mockReturnValue(held), finish };
  }

  it('reports each poll\'s indexed plugin set to onProgress while the load PUT is still in flight', async () => {
    const { PUT, finish } = heldLoad();
    const repository = makeRepository();
    repository.getLoadOrderStatus
      .mockResolvedValueOnce(makeStatus({ indexedPlugins: ['Fallout4.esm'] }))
      .mockResolvedValueOnce(makeStatus({ indexedPlugins: ['Fallout4.esm', 'Foo.esp'] }));
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), PUT }, repository }));
    const onProgress = vi.fn();

    const load = ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { onProgress });

    await vi.advanceTimersByTimeAsync(500);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ indexedPlugins: ['Fallout4.esm'] }));
    await vi.advanceTimersByTimeAsync(500);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ indexedPlugins: ['Fallout4.esm', 'Foo.esp'] }),
    );
    expect(onProgress).toHaveBeenCalledTimes(2);

    finish();
    await load;
  });

  it('stops polling once the load PUT settles, so a finished load leaves no timer running', async () => {
    const { PUT, finish } = heldLoad();
    const repository = makeRepository();
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), PUT }, repository }));
    const onProgress = vi.fn();

    const load = ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { onProgress });
    await vi.advanceTimersByTimeAsync(500);
    finish();
    await load;
    const pollsAtCompletion = repository.getLoadOrderStatus.mock.calls.length;
    // Guards the assertion below against passing vacuously: "no further polls" means nothing
    // unless the load was actually polling in the first place.
    expect(pollsAtCompletion).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(5000);

    expect(repository.getLoadOrderStatus.mock.calls).toHaveLength(pollsAtCompletion);
  });

  // A per-plugin failure is reported the moment it happens, not held back until the load
  // finishes — the caller decorates that row straight away (ADR-0026).
  it('carries the failures reported so far on each tick, before the load has finished', async () => {
    const { PUT, finish } = heldLoad();
    const repository = makeRepository();
    repository.getLoadOrderStatus.mockResolvedValue(
      makeStatus({ indexedPlugins: ['Fallout4.esm'], failures: [{ name: 'Bad.esp', reason: 'RACE parse' }] }),
    );
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), PUT }, repository }));
    const onProgress = vi.fn();

    const load = ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { onProgress });
    await vi.advanceTimersByTimeAsync(500);

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ failures: [{ name: 'Bad.esp', reason: 'RACE parse' }] }),
    );

    finish();
    await load;
  });

  // ADR-0026 background/recoverable tier: a status poll is frequent and non-essential — a blip
  // gets a log line and the next tick, never a toast and never an aborted load.
  it('logs a failed status poll and keeps polling, without surfacing it or failing the load', async () => {
    const { PUT, finish } = heldLoad();
    const repository = makeRepository();
    repository.getLoadOrderStatus
      .mockRejectedValueOnce(new Error('GET /load-order/status failed (500)'))
      .mockResolvedValue(makeStatus({ indexedPlugins: ['Foo.esp'] }));
    const log = vi.fn();
    const deps = makeDeps({ client: { ...makeClient(), PUT }, repository, log });
    const ctrl = new EditingController(deps);
    const onProgress = vi.fn();

    const load = ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { onProgress });
    await vi.advanceTimersByTimeAsync(500);
    expect(onProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ indexedPlugins: ['Foo.esp'] }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('load-order/status'));
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.showWarning).not.toHaveBeenCalled();

    finish();
    await load;
  });
});

// ── putLoadOrder: a deliberately abandoned load is not a failure ─────────────

// Two ways a load ends without failing.
// 409 is the backend saying "your snapshot was superseded" (LoadOrderEndpoints.SupersededReconcile) —
// nothing went wrong, and the newer load now owns the load order. An aborted PUT is the user
// closing mEdit mid-load. Neither is something to toast, and neither may
// make the caller tear down a load order it does not own.
describe('EditingController.putLoadOrder abandonment', () => {
  beforeEach(() => vi.resetAllMocks());

  const plugins = [{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }];

  it('does not surface an error when the load is superseded (409), only logs it', async () => {
    const client = { ...makeClient(), PUT: vi.fn().mockResolvedValue(drainedError(409, 'superseded')) };
    const log = vi.fn();
    const deps = makeDeps({ client, log });

    await new EditingController(deps).putLoadOrder(plugins, '/game/Data', '/instance');

    expect(deps.showError).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('superseded'));
  });

  // If a superseded load returned the same "no load order"
  // answer a failed one does, makeEnterEditing would respond by calling exitToLoadout() —
  // tearing the backend down out from under the newer load that legitimately owns the load order.
  // Reachable by running Reload Load Order while a load is still running.
  it('reports a superseded load as abandoned, distinctly from a failed one', async () => {
    const client = { ...makeClient(), PUT: vi.fn().mockResolvedValue(drainedError(409, 'superseded')) };
    const deps = makeDeps({ client });

    const result = await new EditingController(deps).putLoadOrder(plugins, '/game/Data', '/instance');

    expect(result).toEqual({ outcome: 'abandoned' });
    // Whatever load superseded this one owns the notification, if any — this one never
    // reached a settled state of its own to announce.
    expect(deps.notifyConflictsComputed).not.toHaveBeenCalled();
  });

  it('reports an aborted load as abandoned, and surfaces nothing for it', async () => {
    const controller = new AbortController();
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockImplementation(() => {
        controller.abort();
        return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
      }),
    };
    const deps = makeDeps({ client });

    const result = await new EditingController(deps)
      .putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { signal: controller.signal });

    expect(result).toEqual({ outcome: 'abandoned' });
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.notifyConflictsComputed).not.toHaveBeenCalled();
  });

  // The signal is what aborts the request itself rather than waiting for a dead socket — the
  // whole reason this uses stdlib AbortSignal instead of a bespoke cancellation flag.
  it('forwards the abort signal to the PUT so the request is cancelled, not merely ignored', async () => {
    const signal = new AbortController().signal;
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } }),
    };

    await new EditingController(makeDeps({ client })).putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { signal });

    expect(client.PUT).toHaveBeenCalledWith('/load-order', expect.objectContaining({ signal }));
  });
});

// ── resolveOrigin ────────────────────────────────────────────────────────────

describe('EditingController.resolveOrigin', () => {
  beforeEach(() => vi.resetAllMocks());

  it('finds the loaded origin for a plugin name', async () => {
    const repository = makeRepository({ plugins: makePlugins(2) });
    const deps = makeDeps({ repository });
    const controller = new EditingController(deps);

    const origin = await controller.resolveOrigin('Plugin1.esp');

    expect(origin).toBe('Data');
  });

  it('answers undefined for a name the load order has not loaded', async () => {
    const repository = makeRepository({ plugins: makePlugins(2) });
    const deps = makeDeps({ repository });
    const controller = new EditingController(deps);

    const origin = await controller.resolveOrigin('NotLoaded.esp');

    expect(origin).toBeUndefined();
  });

  // Before Launch mEdit, no backend exists to answer GET /plugins at all — a rejected
  // repository call, not a 200 with an empty/mismatched list. Every sibling EditingController
  // method (track, compile, rebaseOntoMain, …) catches its own transport failure and
  // degrades to a caught, logged outcome; without the same here the
  // rejection would propagate out of Track/Rebase/Save & Compile's command callbacks uncaught — VS
  // Code's own raw "Error running command … fetch failed" toast, not this codebase's error
  // surfacing. Degrading to the same `undefined` "not found" already returns costs nothing new:
  // every caller already turns that into a clear, existing message.
  it('degrades to undefined — not a thrown rejection — when the backend itself is unreachable', async () => {
    const repository = makeRepository({ plugins: makePlugins(2) });
    repository.getPlugins = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const log = vi.fn();
    const deps = makeDeps({ repository, log });
    const controller = new EditingController(deps);

    const origin = await controller.resolveOrigin('Plugin1.esp');

    expect(origin).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('resolveOrigin'));
  });
});

// ── track ───────────────────────────────────────────────────────────────────

describe('EditingController.track', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the origin and preset, and refreshes the tree', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const ok = await controller.track('ModA', 'Edits');

    expect(ok).toBe(true);
    expect(deps.client.POST).toHaveBeenCalledWith('/plugins/track', {
      body: { origin: 'ModA', preset: 'Edits' },
    });
    expect(deps.refreshTree).toHaveBeenCalled();
  });

  // ADR-0026 "explicit action failed" tier: the user asked for this, so a failure is a
  // notification, not a log line — and nothing is refreshed, because nothing changed.
  it('surfaces a failure and reports that it did not happen', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue(drainedError(409, 'This mod folder is already tracked.'));
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const ok = await controller.track('ModA', 'Edits');

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('already tracked'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('surfaces a thrown request the same way', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const ok = await controller.track('ModA', 'Edits');

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });
});

// ── create/delete/renumber record ───────────────────────────────────────────

describe('EditingController.createRecord', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the plugin/origin/recordType/editorId, refreshes the tree, and returns the new FormKey', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const formKey = await controller.createRecord('MyPatch.esp', 'ModA', 'npc_', 'NewNpc');

    expect(formKey).toBe('000801:MyPatch.esp');
    expect(deps.client.POST).toHaveBeenCalledWith('/plugins/{plugin}/records', {
      params: { path: { plugin: 'MyPatch.esp' } },
      body: { origin: 'ModA', recordType: 'npc_', editorId: 'NewNpc', formKey: null },
    });
    expect(deps.refreshTree).toHaveBeenCalled();
    // A create is a working-tree change to a tracked plugin's source — the same re-derive
    // `hasMatchingRecords` needs (ADR-0035 amending ADR-0018): a new record can start matching
    // the active filter.
    expect(deps.refreshMatchingPlugins).toHaveBeenCalled();
  });

  it('passes an explicit requested FormKey through, xEdit\'s typed-FormID path', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    await controller.createRecord('MyPatch.esp', 'ModA', 'npc_', undefined, '000900:MyPatch.esp');

    expect(deps.client.POST).toHaveBeenCalledWith('/plugins/{plugin}/records', {
      params: { path: { plugin: 'MyPatch.esp' } },
      body: { origin: 'ModA', recordType: 'npc_', editorId: null, formKey: '000900:MyPatch.esp' },
    });
  });

  // ADR-0026 "explicit action failed" tier: the user asked for this, so a failure is a
  // notification, not a log line — and nothing is refreshed, because nothing changed.
  it('surfaces a refusal and reports that it did not happen', async () => {
    const client = makeClient({ createRecordOk: false });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const formKey = await controller.createRecord('MyPatch.esp', 'ModA', 'npc_');

    expect(formKey).toBeUndefined();
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('MyPatch.esp'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('surfaces a thrown request the same way', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const formKey = await controller.createRecord('MyPatch.esp', 'ModA', 'npc_');

    expect(formKey).toBeUndefined();
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });
});

describe('EditingController.deleteRecord', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the FormKey/plugin/origin and refreshes the tree', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const ok = await controller.deleteRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(ok).toBe(true);
    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/delete', {
      params: { path: { formKey: '000801:MyPatch.esp' } },
      body: { plugin: 'MyPatch.esp', origin: 'ModA' },
    });
    expect(deps.refreshTree).toHaveBeenCalled();
    // Same reason as createRecord above — a delete is a working-tree change too.
    expect(deps.refreshMatchingPlugins).toHaveBeenCalled();
  });

  it('surfaces a refusal and reports that it did not happen', async () => {
    const client = makeClient({ deleteRecordOk: false });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const ok = await controller.deleteRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('000801:MyPatch.esp'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('surfaces a thrown request the same way', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const ok = await controller.deleteRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(ok).toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });
});

describe('EditingController.renumberRecord', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the FormKey/plugin/origin, refreshes the tree, and returns the new FormKey', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const newFormKey = await controller.renumberRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(newFormKey).toBe('000802:MyPatch.esp');
    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/renumber', {
      params: { path: { formKey: '000801:MyPatch.esp' } },
      body: { plugin: 'MyPatch.esp', origin: 'ModA', newFormKey: null },
    });
    expect(deps.refreshTree).toHaveBeenCalled();
    // Same reason as createRecord above — a renumber (delete+create) is a working-tree
    // change too.
    expect(deps.refreshMatchingPlugins).toHaveBeenCalled();
  });

  it('passes an explicit requested target FormKey through, xEdit\'s typed-FormID path', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    await controller.renumberRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA', '000900:MyPatch.esp');

    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/renumber', {
      params: { path: { formKey: '000801:MyPatch.esp' } },
      body: { plugin: 'MyPatch.esp', origin: 'ModA', newFormKey: '000900:MyPatch.esp' },
    });
  });

  // Covers both the untracked-referencer refusal and a partial-cascade I/O failure —
  // both are already-messaged, non-2xx responses by the time they reach this method, so they are
  // one code path here regardless of which one produced the response.
  it('surfaces a refusal and reports that it did not happen', async () => {
    const client = makeClient({ renumberRecordOk: false });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const newFormKey = await controller.renumberRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(newFormKey).toBeUndefined();
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('000801:MyPatch.esp'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('surfaces a thrown request the same way', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const newFormKey = await controller.renumberRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(newFormKey).toBeUndefined();
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });
});

// Track progress is polled off GET /plugins/track/status alongside the
// still in-flight track POST, the identical seam/idiom the load-progress suite above tests
// (a held POST + fake timers, no VS Code types).
describe('EditingController.track progress polling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  /** A track POST that stays in flight until the returned `finish` is called — mirrors
   *  `heldLoad()` above; the whole point is what happens *during* that window. */
  function heldTrack() {
    let finish!: () => void;
    const held = new Promise((resolve) => {
      finish = () => resolve({ response: { ok: true }, data: { origin: 'ModA' } });
    });
    return { POST: vi.fn().mockReturnValue(held), finish };
  }

  it('reports each poll\'s progress to onProgress while the track POST is still in flight', async () => {
    const { POST, finish } = heldTrack();
    const repository = makeRepository();
    repository.getTrackStatus
      .mockResolvedValueOnce({ phase: 'Serializing', pluginsDone: 10, pluginsTotal: 100 })
      .mockResolvedValueOnce({ phase: 'Serializing', pluginsDone: 50, pluginsTotal: 100 });
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), POST }, repository }));
    const onProgress = vi.fn();

    const track = ctrl.track('ModA', 'Edits', { onProgress });

    await vi.advanceTimersByTimeAsync(500);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'Serializing', pluginsDone: 10, pluginsTotal: 100 }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'Serializing', pluginsDone: 50, pluginsTotal: 100 }),
    );
    expect(onProgress).toHaveBeenCalledTimes(2);

    finish();
    await track;
  });

  it('stops polling once the track POST settles, so a finished track leaves no timer running', async () => {
    const { POST, finish } = heldTrack();
    const repository = makeRepository();
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), POST }, repository }));
    const onProgress = vi.fn();

    const track = ctrl.track('ModA', 'Edits', { onProgress });
    finish();
    await track;
    repository.getTrackStatus.mockClear();

    await vi.advanceTimersByTimeAsync(2000);

    expect(repository.getTrackStatus).not.toHaveBeenCalled();
  });

  it('a track with no onProgress polls nothing at all', async () => {
    const { POST, finish } = heldTrack();
    const repository = makeRepository();
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), POST }, repository }));

    const track = ctrl.track('ModA', 'Edits');
    await vi.advanceTimersByTimeAsync(1000);
    expect(repository.getTrackStatus).not.toHaveBeenCalled();

    finish();
    await track;
  });
});

// ── absorb / keep / rebase ────────────────────────────────────────────────────

describe('EditingController.absorbUpstreamUpdate', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the plugin and origin, and refreshes the tree on success', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({ response: { ok: true, status: 200 }, data: { succeeded: true, refusalReason: null } });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.absorbUpstreamUpdate('Fixture.esp', 'ModA');

    expect(result).toEqual({ succeeded: true, refusalReason: null });
    expect(client.POST).toHaveBeenCalledWith('/plugins/{plugin}/external-change/absorb', {
      params: { path: { plugin: 'Fixture.esp' } },
      body: { origin: 'ModA' },
    });
    expect(deps.refreshTree).toHaveBeenCalled();
    // Absorbing a new baseline moves the source under this plugin the same way a track
    // does — the same re-derive createRecord gives `hasMatchingRecords`, since the plugin's
    // records (and hence which match the active filter) can change.
    expect(deps.refreshMatchingPlugins).toHaveBeenCalled();
  });

  it('surfaces a transport failure as null, without refreshing', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue(drainedError(500, 'git unavailable'));
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.absorbUpstreamUpdate('Fixture.esp', 'ModA');

    expect(result).toBeNull();
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('git unavailable'));
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });
});

describe('EditingController.keepAsMyEdit', () => {
  beforeEach(() => vi.resetAllMocks());

  it('surfaces a typed collision refusal as a real result, not a thrown error', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { succeeded: false, refusalReason: 'Fixture.esp has uncommitted changes on 000800:Fixture.esp.' },
    });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.keepAsMyEdit('Fixture.esp', 'ModA');

    expect(result).toEqual({ succeeded: false, refusalReason: 'Fixture.esp has uncommitted changes on 000800:Fixture.esp.' });
    // A refused Keep changed nothing — no reason to refresh.
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('refreshes the tree once a Keep actually lands', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({ response: { ok: true, status: 200 }, data: { succeeded: true, refusalReason: null } });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    await controller.keepAsMyEdit('Fixture.esp', 'ModA');

    expect(deps.refreshTree).toHaveBeenCalled();
    // Keeping an external change deserializes into working-tree dirt — same reason as
    // absorbUpstreamUpdate above.
    expect(deps.refreshMatchingPlugins).toHaveBeenCalled();
  });
});

describe('EditingController.rebaseOntoMain / continueRebase', () => {
  beforeEach(() => vi.resetAllMocks());

  it('rebaseOntoMain POSTs the origin to /plugins/rebase and reports a clean outcome', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { outcome: 'Clean', refusalReason: null, conflictedPaths: [] },
    });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.rebaseOntoMain('ModA');

    expect(result).toEqual({ outcome: 'Clean', refusalReason: null, conflictedPaths: [] });
    expect(client.POST).toHaveBeenCalledWith('/plugins/rebase', { body: { origin: 'ModA' } });
    expect(deps.refreshTree).toHaveBeenCalled();
    // A rebase moves the branch, which can change a tracked plugin's compile-freshness
    // answer — same reason absorbUpstreamUpdate/keepAsMyEdit above refresh it.
    expect(deps.refreshMatchingPlugins).toHaveBeenCalled();
  });

  it('rebaseOntoMain reports a refused outcome (uncommitted dirt), still typed, not thrown', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { outcome: 'Refused', refusalReason: 'Cannot rebase: uncommitted changes in X.', conflictedPaths: [] },
    });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.rebaseOntoMain('ModA');

    expect(result?.outcome).toBe('Refused');
    expect(result?.refusalReason).toContain('uncommitted changes');
  });

  it('rebaseOntoMain reports a conflicted outcome naming the paths', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/Fixture.esp/npc_/000800.json'] },
    });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.rebaseOntoMain('ModA');

    expect(result?.outcome).toBe('Conflicted');
    expect(result?.conflictedPaths).toEqual(['source/Fixture.esp/npc_/000800.json']);
  });

  it('continueRebase POSTs to /plugins/rebase/continue', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { outcome: 'Clean', refusalReason: null, conflictedPaths: [] },
    });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    await controller.continueRebase('ModA');

    expect(client.POST).toHaveBeenCalledWith('/plugins/rebase/continue', { body: { origin: 'ModA' } });
  });

  it('surfaces a transport failure as null', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue(drainedError(404, "No loaded plugin has origin 'ModA'."));
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.rebaseOntoMain('ModA');

    expect(result).toBeNull();
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining("No loaded plugin has origin 'ModA'"));
  });
});

