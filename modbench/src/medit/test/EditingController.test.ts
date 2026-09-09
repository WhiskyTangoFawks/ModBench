import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditingController, type EditingControllerDeps } from '../EditingController';
import type { PluginMetadata, NotificationEvent } from '../ApiClient';
import { FakeNotificationSubscriber } from '../NotificationSubscriber';
import type { components } from '../generated/api';

function loadOrderStatusEvent(status: Partial<components['schemas']['LoadOrderStatus']> = {}): NotificationEvent {
  return {
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: { state: 'Reconciling', totalPlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [], ...status },
  };
}

function trackProgressEvent(progress: Partial<components['schemas']['TrackProgress']> = {}): NotificationEvent {
  return {
    kind: 'track-progress', plugin: '', origin: '', keys: [], sequence: 0,
    trackProgress: { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0, ...progress },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Mimics a real non-ok openapi-fetch result: the body stream is already drained, so a second
// `response.text()` throws. Production code must read `error`, not re-read the body.
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
    hasParseFailure: false,
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
  rebuildIndexOk = true,
}: {
  plugins?: PluginMetadata[];
  createPluginOk?: boolean;
  createRecordOk?: boolean;
  deleteRecordOk?: boolean;
  renumberRecordOk?: boolean;
  copyAsOverrideOk?: boolean;
  copyAsNewRecordOk?: boolean;
  rebuildIndexOk?: boolean;
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
      if (path === '/index/rebuild') {
        return Promise.resolve(
          rebuildIndexOk ? { response: { ok: true, status: 204 } } : drainedError(423, 'Locked'),
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
      if (path === '/plugins/track') {
        return Promise.resolve({ response: { ok: true, status: 200 }, data: { origin: 'ModA' } });
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
    getRecordTypes: vi.fn().mockResolvedValue([]),
    getRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as any;
}

function makeDeps(overrides: Partial<EditingControllerDeps> = {}): EditingControllerDeps {
  return {
    client: makeClient(),
    repository: makeRepository(),
    notificationSubscriber: new FakeNotificationSubscriber(),
    ...overrides,
  };
}

// A `WriteRefused` is `{ refused: true, message }` — this narrows a verb's return value to it,
// failing loudly (not silently passing `undefined`) if the verb answered anything else.
function asRefused(result: unknown): { refused: true; message: string } {
  expect(result).toEqual(expect.objectContaining({ refused: true }));
  return result as { refused: true; message: string };
}

// ── createPlugin ──────────────────────────────────────────────────────────────

describe('EditingController.createPlugin', () => {
  beforeEach(() => vi.resetAllMocks());

  // The destination is the caller's — Mod Management's QuickPick, not an implicit write into the
  // Data folder — and the created plugin's own name comes back from the response, never assumed.
  it('POSTs to /plugins/create with the destination and resolves the wire response', async () => {
    const deps = makeDeps();
    const ctrl = new EditingController(deps);

    const result = await ctrl.createPlugin('MyPatch.esp', '/mods/MyMod', 'MyMod');

    expect(deps.client.POST).toHaveBeenCalledWith(
      '/plugins/create',
      expect.objectContaining({ body: { name: 'MyPatch.esp', path: '/mods/MyMod', origin: 'MyMod' } }),
    );
    expect(result).toEqual({ name: 'test.esp' });
  });

  it('resolves a WriteRefused carrying the ready-to-show toast on failure', async () => {
    const deps = makeDeps({ client: makeClient({ createPluginOk: false }) });
    const ctrl = new EditingController(deps);

    const result = asRefused(await ctrl.createPlugin('MyPatch.esp', '/mods/MyMod', 'MyMod'));

    expect(result.message).toContain('Failed to create plugin');
    expect(result.message).toContain('Bad Request');
  });
});

// ── rebuildIndex ──────────────────────────────────────────────────────────────

describe('EditingController.rebuildIndex', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs to /index/rebuild with the instance and game release, and resolves true', async () => {
    const deps = makeDeps();
    const ctrl = new EditingController(deps);
    const onFailure = vi.fn();

    const result = await ctrl.rebuildIndex('/mo2/instance', onFailure, 'Fallout4');

    expect(deps.client.POST).toHaveBeenCalledWith(
      '/index/rebuild',
      expect.objectContaining({ body: { instanceRoot: '/mo2/instance', gameRelease: 'Fallout4' } }),
    );
    expect(result).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
  });

  // Not a bare toast: the caller's own report, e.g. a held-index 423 routed through makeReporter
  // (modbench/CLAUDE.md) — the shape every other verb in this class now follows too.
  it('reports through the caller-supplied onFailure, and resolves false', async () => {
    const deps = makeDeps({ client: makeClient({ rebuildIndexOk: false }) });
    const ctrl = new EditingController(deps);
    const onFailure = vi.fn();

    const result = await ctrl.rebuildIndex('/mo2/instance', onFailure, 'Fallout4');

    expect(result).toBe(false);
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

// ── copyRecordAsOverride / copyRecordAsNewRecord ──────────────────────────────

describe('EditingController.copyRecordAsOverride', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the source/destination plugin+origin and resolves the wire response', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const result = await controller.copyRecordAsOverride('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA');

    expect(result).toEqual({ applied: true, formKey: '000801:MyPatch.esp' });
    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/copy-as-override', {
      params: { path: { formKey: '000801:Fallout4.esm' } },
      body: { sourcePlugin: 'Fallout4.esm', sourceOrigin: 'Data', destinationPlugin: 'MyPatch.esp', destinationOrigin: 'ModA' },
    });
  });
});

describe('EditingController.copyRecordAsNewRecord', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the source/destination plugin+origin with a null requestedFormKey and resolves the wire response', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const result = await controller.copyRecordAsNewRecord('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA');

    expect(result).toEqual({ applied: true, sourceFormKey: '000801:MyPatch.esp', newFormKey: '000802:MyPatch.esp' });
    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/copy-as-new-record', {
      params: { path: { formKey: '000801:Fallout4.esm' } },
      body: {
        sourcePlugin: 'Fallout4.esm', sourceOrigin: 'Data', destinationPlugin: 'MyPatch.esp', destinationOrigin: 'ModA',
        requestedFormKey: null,
      },
    });
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
});

// ── setFilter ─────────────────────────────────────────────────────────────────

describe('EditingController.setFilter', () => {
  beforeEach(() => vi.resetAllMocks());

  it('calls repository.setFilter and resolves null on success', async () => {
    const repository = makeRepository();
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    const result = await ctrl.setFilter('SELECT form_key FROM "npc_"');

    expect(result).toBeNull();
    expect(repository.setFilter).toHaveBeenCalledWith('SELECT form_key FROM "npc_"');
  });

  it('resolves the repository\'s own error message, unframed, when repository.setFilter fails', async () => {
    const repository = makeRepository({ setFilterError: 'Filter SQL must return a form_key column' });
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    const result = await ctrl.setFilter('SELECT editor_id FROM "npc_"');

    expect(result).toBe('Filter SQL must return a form_key column');
  });
});

// ── clearFilter ───────────────────────────────────────────────────────────────

describe('EditingController.clearFilter', () => {
  beforeEach(() => vi.resetAllMocks());

  it('calls repository.clearFilter', async () => {
    const repository = makeRepository();
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    await ctrl.clearFilter();

    expect(repository.clearFilter).toHaveBeenCalledOnce();
  });
});

// ── syncFilterState ───────────────────────────────────────────────────────────

describe('EditingController.syncFilterState', () => {
  beforeEach(() => vi.resetAllMocks());

  it('resolves the active filter\'s SQL when one is returned', async () => {
    const repository = makeRepository({ activeFilter: 'SELECT form_key FROM "npc_"' });
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    expect(await ctrl.syncFilterState()).toBe('SELECT form_key FROM "npc_"');
  });

  it('resolves null when no filter is active', async () => {
    const repository = makeRepository({ activeFilter: null });
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    expect(await ctrl.syncFilterState()).toBeNull();
  });

  it('resolves a WriteRefused carrying the read failure, without throwing', async () => {
    const repository = makeRepository();
    repository.getActiveFilter = vi.fn().mockRejectedValue(new Error('getActiveFilter failed (500): boom'));
    const deps = makeDeps({ repository });
    const ctrl = new EditingController(deps);

    const result = asRefused(await ctrl.syncFilterState());

    expect(result.message).toContain('Could not read the active filter');
    expect(result.message).toContain('boom');
  });
});

// ── putLoadOrder ───────────────────────────────────────────────────────

describe('EditingController.putLoadOrder', () => {
  beforeEach(() => vi.resetAllMocks());

  const plugins = [
    { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true },
    { name: 'Fallout4.esm', path: '/game/Data/Fallout4.esm', origin: 'Data', slot: 1, enabled: true, winning: true },
  ];

  it('PUTs the ordered plugin list + dataFolder game directory + MO2 instance root', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } }),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    await ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');

    expect(deps.client.PUT).toHaveBeenCalledWith(
      '/load-order',
      expect.objectContaining({
        // ADR-0001: instanceRoot is what the backend keys its persistent index on — omitting
        // it would let two MO2 instances with same-named mod folders read each other's records.
        body: { plugins, gameDirectory: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4' },
      }),
    );
  });

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

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');

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

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');

    // Still distinguishable from a failed load — by the outcome tag rather than by
    // `[]` versus `undefined`.
    expect(result).toEqual({ outcome: 'reconciled', failures: [], crashRepairOffers: [] });
  });

  // crashRepairOffers rides the same response failures already does — the caller reads them off
  // the return value to run the repair-offer dialog, never a second fetch.
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

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');

    expect(result).toEqual({
      outcome: 'reconciled', failures: [],
      crashRepairOffers: [{ plugin: 'Foo.esp', origin: 'A', reason: 'InterruptedCompile' }],
    });
  });

  it('resolves a WriteRefused-shaped failure carrying the ready-to-show toast when the load fails', async () => {
    const client = {
      ...makeClient(),
      PUT: vi.fn().mockResolvedValue(drainedError(400, 'bad dir')),
    };
    const deps = makeDeps({ client });
    const ctrl = new EditingController(deps);

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');

    // The `failed` tag leaves room for the third outcome (ADR-0044): the backend tore nothing
    // down — it still holds what it held — so the caller leaves the view alone rather than exiting.
    expect(result).toEqual({ outcome: 'failed', message: expect.stringContaining('bad dir') });
  });

  // ADR-0001 point 6: another window holds this instance's index. The backend's 423
  // ProblemDetails carries the sentence for the user, and the load is a plain failure.
  it('carries which cause refused the load when another window holds the instance (423)', async () => {
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

    const result = await ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');

    expect(result).toEqual({ outcome: 'failed', message: expect.stringContaining('open in another Modbench window') });
    expect((result as { message: string }).message).not.toContain('"status"');
  });
});

// ── putLoadOrder: progressive load (ADR-0035) ───────────────────

// The load PUT stays blocking and the generated openapi-fetch client has no streaming path, so
// progress rides load-order-status notifications alongside the still in-flight PUT.
describe('EditingController.putLoadOrder progress subscription', () => {
  beforeEach(() => vi.resetAllMocks());

  const plugins = [
    { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true },
    { name: 'Fallout4.esm', path: '/game/Data/Fallout4.esm', origin: 'Data', slot: 1, enabled: true, winning: true },
  ];

  // A load PUT held in flight until `finish` is called; this suite is about that window.
  function heldLoad() {
    let finish!: () => void;
    const held = new Promise((resolve) => {
      finish = () => resolve({ response: { ok: true }, data: { status: 'reconciled', failures: [], crashRepairOffers: [] } });
    });
    return { PUT: vi.fn().mockReturnValue(held), finish };
  }

  it('reports each load-order-status notification\'s indexed plugin set to onProgress while the load PUT is still in flight', async () => {
    const { PUT, finish } = heldLoad();
    const notificationSubscriber = new FakeNotificationSubscriber();
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), PUT }, notificationSubscriber }));
    const onProgress = vi.fn();

    const load = ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { onProgress });

    notificationSubscriber.emit(loadOrderStatusEvent({ indexedPlugins: [{ name: 'Fallout4.esm', origin: 'Data' }] }));
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ indexedPlugins: ['Fallout4.esm'] }));
    notificationSubscriber.emit(loadOrderStatusEvent({
      indexedPlugins: [{ name: 'Fallout4.esm', origin: 'Data' }, { name: 'Foo.esp', origin: 'A' }],
    }));
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ indexedPlugins: ['Fallout4.esm', 'Foo.esp'] }),
    );
    expect(onProgress).toHaveBeenCalledTimes(2);

    finish();
    await load;
  });

  // The rival: PUT as soon as the listener is registered. The backend publishes its first tick as
  // the PUT lands, so a PUT that outran the stream loses every tick published before it connects.
  it('holds the load PUT until the notification stream is carrying events', async () => {
    const { PUT, finish } = heldLoad();
    let connect!: () => void;
    const subscriber = new FakeNotificationSubscriber();
    const notificationSubscriber = {
      subscribe: subscriber.subscribe.bind(subscriber),
      whenConnected: () => new Promise<void>((resolve) => { connect = resolve; }),
    };
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), PUT }, notificationSubscriber }));

    const load = ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { onProgress: vi.fn() });
    await Promise.resolve();
    expect(PUT).not.toHaveBeenCalled();

    connect();
    await vi.waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    finish();
    await load;
  });

  it('unsubscribes once the load PUT settles, so a finished load reports no further progress', async () => {
    const { PUT, finish } = heldLoad();
    const notificationSubscriber = new FakeNotificationSubscriber();
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), PUT }, notificationSubscriber }));
    const onProgress = vi.fn();

    const load = ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { onProgress });
    notificationSubscriber.emit(loadOrderStatusEvent());
    // Guards the assertion below against passing vacuously: "no further calls" means nothing
    // unless the load was actually subscribed in the first place.
    expect(onProgress).toHaveBeenCalledTimes(1);
    finish();
    await load;

    notificationSubscriber.emit(loadOrderStatusEvent());

    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  // A per-plugin failure is reported the moment it happens, not held back until the load
  // finishes — the caller decorates that row straight away (ADR-0026).
  it('carries the failures reported so far on each notification, before the load has finished', async () => {
    const { PUT, finish } = heldLoad();
    const notificationSubscriber = new FakeNotificationSubscriber();
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), PUT }, notificationSubscriber }));
    const onProgress = vi.fn();

    const load = ctrl.putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4', { onProgress });
    notificationSubscriber.emit(loadOrderStatusEvent({
      indexedPlugins: [{ name: 'Fallout4.esm', origin: 'Data' }],
      failures: [{ name: 'Bad.esp', reason: 'RACE parse' }],
    }));

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ failures: [{ name: 'Bad.esp', reason: 'RACE parse' }] }),
    );

    finish();
    await load;
  });
});

// ── putLoadOrder: a deliberately abandoned load is not a failure ─────────────

// 409 is the backend saying the snapshot was superseded; an aborted PUT is the user closing
// mEdit mid-load. Neither is something to toast, and neither may make the caller tear down a
// load order it does not own.
describe('EditingController.putLoadOrder abandonment', () => {
  beforeEach(() => vi.resetAllMocks());

  const plugins = [{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }];

  it('only logs, without surfacing an error, when the load is superseded (409)', async () => {
    const client = { ...makeClient(), PUT: vi.fn().mockResolvedValue(drainedError(409, 'superseded')) };
    const log = vi.fn();
    const deps = makeDeps({ client, log });

    const result = await new EditingController(deps).putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');

    expect(result).toEqual({ outcome: 'abandoned' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('superseded'));
  });

  // If a superseded load answered the way a failed one does, makeEnterEditing would call
  // exitEditing(), tearing the backend down under the newer load that owns the load order.
  it('reports a superseded load as abandoned, distinctly from a failed one', async () => {
    const client = { ...makeClient(), PUT: vi.fn().mockResolvedValue(drainedError(409, 'superseded')) };
    const deps = makeDeps({ client });

    const result = await new EditingController(deps).putLoadOrder(plugins, '/game/Data', '/instance', 'Fallout4');

    expect(result).toEqual({ outcome: 'abandoned' });
  });

  it('reports an aborted load as abandoned, and carries no message', async () => {
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

  // Before Launch mEdit no backend answers GET /plugins, so the call rejects. Uncaught, that
  // surfaces as VS Code's own raw "Error running command … fetch failed" toast.
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

// ── implicit masters ────────────────────────────────────────────────────────
//
// Mod Management's plugins.txt reconcile asks this while deciding which disk plugins earn a
// line. "Unknown" and "none" must not be the same answer: the reconcile writes on one.

describe('EditingController.implicitMasters', () => {
  beforeEach(() => vi.resetAllMocks());

  it('answers the names the backend reports, in the order given', async () => {
    const client = makeClient();
    client.GET = vi.fn().mockResolvedValue({ data: ['Fallout4.esm', 'ccTest.esl'], response: { ok: true } });
    const controller = new EditingController(makeDeps({ client }));

    expect(await controller.implicitMasters('/game/Data', 'Fallout4')).toEqual(['Fallout4.esm', 'ccTest.esl']);
    expect(client.GET).toHaveBeenCalledWith('/implicit-masters', {
      params: { query: { gameDirectory: '/game/Data', gameRelease: 'Fallout4' } },
    });
  });

  it('answers undefined, never an empty list, when the backend refuses', async () => {
    const client = makeClient();
    client.GET = vi.fn().mockResolvedValue(drainedError(400, 'Game directory not found'));
    const log = vi.fn();
    const controller = new EditingController(makeDeps({ client, log }));

    expect(await controller.implicitMasters('/no/such/Data', 'Fallout4')).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('implicitMasters'));
  });

  it('answers undefined, never an empty list, when the backend is unreachable', async () => {
    const client = makeClient();
    client.GET = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const log = vi.fn();
    const controller = new EditingController(makeDeps({ client, log }));

    expect(await controller.implicitMasters('/game/Data', 'Fallout4')).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('implicitMasters'));
  });
});

// ── track ───────────────────────────────────────────────────────────────────

describe('EditingController.track', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the origin and preset, and resolves the wire response', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const result = await controller.track('ModA', 'Edits');

    expect(result).toEqual({ origin: 'ModA' });
    expect(deps.client.POST).toHaveBeenCalledWith('/plugins/track', {
      body: { origin: 'ModA', preset: 'Edits' },
    });
  });
});

// ── create/delete/renumber record ───────────────────────────────────────────

describe('EditingController.createRecord', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the plugin/origin/recordType/editorId and resolves the wire response', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const result = await controller.createRecord('MyPatch.esp', 'ModA', 'npc_', 'NewNpc');

    expect(result).toEqual({ applied: true, formKey: '000801:MyPatch.esp', recordType: 'npc_' });
    expect(deps.client.POST).toHaveBeenCalledWith('/plugins/{plugin}/records', {
      params: { path: { plugin: 'MyPatch.esp' } },
      body: { origin: 'ModA', recordType: 'npc_', editorId: 'NewNpc', formKey: null },
    });
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

  // ADR-0026: the write gate answers a contended write with 503 + `writeGateTimeout`, the same
  // shape 503 "no load order held" arrives in. Retry versus reload, so the surface reads the
  // extension, never the prose.
  describe('write-gate contention', () => {
    it('says the write is retryable, not that the load order went away', async () => {
      const client = makeClient();
      client.POST = vi.fn().mockResolvedValue({
        error: {
          writeGateTimeout: true,
          detail: 'Another write to the record index is still in progress after 5s.',
        },
        response: { ok: false, status: 503, text: () => Promise.reject(new Error('unused')) },
      });
      const deps = makeDeps({ client });

      const result = asRefused(await new EditingController(deps).renumberRecord('000800:MyPatch.esp', 'MyPatch.esp', 'ModA'));

      expect(result.message).toBe(
        'mEdit: Could not renumber 000800:MyPatch.esp — another change is still being written. Try again in a moment.',
      );
    });

    // The rival this guards against: keying off the 503 status, or off the detail text, rather
    // than off the extension. A load order that genuinely went away is also a 503 — and must keep
    // reading as one.
    it('leaves the load-order-absent 503 exactly as it was', async () => {
      const client = makeClient();
      client.POST = vi.fn().mockResolvedValue(drainedError(503, 'No load order has been received.'));
      const deps = makeDeps({ client });

      const result = asRefused(await new EditingController(deps).renumberRecord('000800:MyPatch.esp', 'MyPatch.esp', 'ModA'));

      expect(result.message).toBe('mEdit: Could not renumber 000800:MyPatch.esp — No load order has been received.');
    });

    // The gate-wrapped endpoints share `mutate`, so the branch is stated once and reached by all of
    // them; the field edit shapes its own outcome in `ApiPluginRepository` instead.
    it('reaches every write command that comes through mutate', async () => {
      const client = makeClient();
      client.POST = vi.fn().mockResolvedValue({
        error: { writeGateTimeout: true, detail: 'Another write to the record index is still in progress after 5s.' },
        response: { ok: false, status: 503, text: () => Promise.reject(new Error('unused')) },
      });
      const deps = makeDeps({ client });

      const result = asRefused(await new EditingController(deps).deleteRecord('000800:MyPatch.esp', 'MyPatch.esp', 'ModA'));

      expect(result.message).toContain('another change is still being written. Try again in a moment.');
    });
  });

  // The ESL-exhaustion refusal carries the same typed marker compile's own
  // eslContradiction does, wired through mutate()'s onEslContradiction hook rather than the
  // ordinary toast-and-fail — declining leaves the refusal exactly as untouched as any other.
  describe('eslContradiction', () => {
    it('an ordinary refusal (no eslContradiction extension) never invokes the hook', async () => {
      const client = makeClient();
      client.POST = vi.fn().mockResolvedValue(drainedError(422, 'RecordTypeNotFound'));
      const deps = makeDeps({ client });
      const onEslContradiction = vi.fn();

      const result = asRefused(await new EditingController(deps).createRecord(
        'MyPatch.esp', 'ModA', 'npc_', undefined, undefined, onEslContradiction,
      ));

      expect(onEslContradiction).not.toHaveBeenCalled();
      expect(result.message).toContain('RecordTypeNotFound');
    });

    it('an eslContradiction refusal calls the hook with the refusal detail, skipping the generic refusal', async () => {
      const client = makeClient();
      client.POST = vi.fn().mockResolvedValue({
        error: { eslContradiction: true, detail: 'MyPatch.esp has exhausted its ESL FormKey space' },
        response: { ok: false, status: 422, text: () => Promise.reject(new Error('unused')) },
      });
      const deps = makeDeps({ client });
      const onEslContradiction = vi.fn().mockResolvedValue(false);

      const result = await new EditingController(deps).createRecord(
        'MyPatch.esp', 'ModA', 'npc_', undefined, undefined, onEslContradiction,
      );

      expect(result).toBeUndefined();
      expect(onEslContradiction).toHaveBeenCalledWith('MyPatch.esp has exhausted its ESL FormKey space');
    });

    it('accepting the hook retries the create once and resolves the retry\'s own response', async () => {
      const client = makeClient();
      client.POST = vi.fn()
        .mockResolvedValueOnce({
          error: { eslContradiction: true, detail: 'exhausted' },
          response: { ok: false, status: 422, text: () => Promise.reject(new Error('unused')) },
        })
        .mockResolvedValueOnce({
          response: { ok: true, status: 200 },
          data: { applied: true, formKey: '001000:MyPatch.esp', recordType: 'npc_' },
        });
      const deps = makeDeps({ client });
      const onEslContradiction = vi.fn().mockResolvedValue(true);

      const result = await new EditingController(deps).createRecord(
        'MyPatch.esp', 'ModA', 'npc_', undefined, undefined, onEslContradiction,
      );

      expect(result).toEqual({ applied: true, formKey: '001000:MyPatch.esp', recordType: 'npc_' });
      expect(client.POST).toHaveBeenCalledTimes(2);
    });

    it('copyRecordAsNewRecord gets the identical hook and retry shape', async () => {
      const client = makeClient();
      client.POST = vi.fn()
        .mockResolvedValueOnce({
          error: { eslContradiction: true, detail: 'exhausted' },
          response: { ok: false, status: 422, text: () => Promise.reject(new Error('unused')) },
        })
        .mockResolvedValueOnce({
          response: { ok: true, status: 200 },
          data: { applied: true, newFormKey: '001001:MyPatch.esp' },
        });
      const deps = makeDeps({ client });
      const onEslContradiction = vi.fn().mockResolvedValue(true);

      const result = await new EditingController(deps).copyRecordAsNewRecord(
        '000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA', undefined, onEslContradiction,
      );

      expect(result).toEqual({ applied: true, newFormKey: '001001:MyPatch.esp' });
      expect(client.POST).toHaveBeenCalledTimes(2);
    });
  });
});

describe('EditingController.deleteRecord', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the FormKey/plugin/origin and resolves the wire response', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const result = await controller.deleteRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(result).toEqual({ applied: true, formKey: '000801:MyPatch.esp' });
    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/delete', {
      params: { path: { formKey: '000801:MyPatch.esp' } },
      body: { plugin: 'MyPatch.esp', origin: 'ModA' },
    });
  });
});

describe('EditingController.renumberRecord', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the FormKey/plugin/origin and resolves the wire response', async () => {
    const deps = makeDeps();
    const controller = new EditingController(deps);

    const result = await controller.renumberRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA');

    expect(result).toEqual({ applied: true, oldFormKey: '000801:MyPatch.esp', newFormKey: '000802:MyPatch.esp' });
    expect(deps.client.POST).toHaveBeenCalledWith('/records/{formKey}/renumber', {
      params: { path: { formKey: '000801:MyPatch.esp' } },
      body: { plugin: 'MyPatch.esp', origin: 'ModA', newFormKey: null },
    });
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
});

// Track progress rides track-progress notifications alongside the still in-flight track POST,
// the identical seam/idiom the load-progress suite above tests.
describe('EditingController.track progress subscription', () => {
  beforeEach(() => vi.resetAllMocks());

  // A track POST held in flight until `finish` is called; this suite is about that window.
  function heldTrack() {
    let finish!: () => void;
    const held = new Promise((resolve) => {
      finish = () => resolve({ response: { ok: true }, data: { origin: 'ModA' } });
    });
    return { POST: vi.fn().mockReturnValue(held), finish };
  }

  it('reports each track-progress notification to onProgress while the track POST is still in flight', async () => {
    const { POST, finish } = heldTrack();
    const notificationSubscriber = new FakeNotificationSubscriber();
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), POST }, notificationSubscriber }));
    const onProgress = vi.fn();

    const track = ctrl.track('ModA', 'Edits', { onProgress });

    notificationSubscriber.emit(trackProgressEvent({ phase: 'Serializing', pluginsDone: 10, pluginsTotal: 100 }));
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'Serializing', pluginsDone: 10, pluginsTotal: 100 }),
    );
    notificationSubscriber.emit(trackProgressEvent({ phase: 'Serializing', pluginsDone: 50, pluginsTotal: 100 }));
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'Serializing', pluginsDone: 50, pluginsTotal: 100 }),
    );
    expect(onProgress).toHaveBeenCalledTimes(2);

    finish();
    await track;
  });

  it('unsubscribes once the track POST settles, so a finished track reports no further progress', async () => {
    const { POST, finish } = heldTrack();
    const notificationSubscriber = new FakeNotificationSubscriber();
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), POST }, notificationSubscriber }));
    const onProgress = vi.fn();

    const track = ctrl.track('ModA', 'Edits', { onProgress });
    finish();
    await track;

    notificationSubscriber.emit(trackProgressEvent());

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('a track with no onProgress subscribes to nothing', async () => {
    const { POST, finish } = heldTrack();
    const notificationSubscriber = new FakeNotificationSubscriber();
    const subscribeSpy = vi.spyOn(notificationSubscriber, 'subscribe');
    const ctrl = new EditingController(makeDeps({ client: { ...makeClient(), POST }, notificationSubscriber }));

    const track = ctrl.track('ModA', 'Edits');
    expect(subscribeSpy).not.toHaveBeenCalled();

    finish();
    await track;
  });
});

// ── absorb / keep / rebase ────────────────────────────────────────────────────

describe('EditingController.absorbUpstreamUpdate', () => {
  beforeEach(() => vi.resetAllMocks());

  it('POSTs the plugin and origin, and resolves the wire response', async () => {
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
  });

  // A refusal rides a 200 as `succeeded: false` — this is not a WriteRefused; the caller reads
  // `refusalReason` off the returned value itself (ADR-0026).
  it('resolves a typed refusal as a real value, not a WriteRefused', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { succeeded: false, refusalReason: 'Fixture.esp could not be parsed from its own binary.' },
    });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.absorbUpstreamUpdate('Fixture.esp', 'ModA');

    expect(result).toEqual({ succeeded: false, refusalReason: 'Fixture.esp could not be parsed from its own binary.' });
  });
});

describe('EditingController.keepAsMyEdit', () => {
  beforeEach(() => vi.resetAllMocks());

  it('resolves a typed collision refusal as a real result, not a thrown error', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { succeeded: false, refusalReason: 'Fixture.esp has uncommitted changes on 000800:Fixture.esp.' },
    });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.keepAsMyEdit('Fixture.esp', 'ModA');

    expect(result).toEqual({ succeeded: false, refusalReason: 'Fixture.esp has uncommitted changes on 000800:Fixture.esp.' });
  });

  it('resolves the wire response once a Keep actually lands', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({ response: { ok: true, status: 200 }, data: { succeeded: true, refusalReason: null } });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.keepAsMyEdit('Fixture.esp', 'ModA');

    expect(result).toEqual({ succeeded: true, refusalReason: null });
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
  });

  it('rebaseOntoMain reports a refused outcome (uncommitted dirt), still typed, not thrown', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { outcome: 'Refused', refusalReason: 'Cannot rebase: uncommitted changes in X.', conflictedPaths: [] },
    });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.rebaseOntoMain('ModA') as { outcome: string; refusalReason: string | null };

    expect(result.outcome).toBe('Refused');
    expect(result.refusalReason).toContain('uncommitted changes');
  });

  it('rebaseOntoMain reports a conflicted outcome naming the paths', async () => {
    const client = makeClient();
    client.POST = vi.fn().mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/Fixture.esp/npc_/000800.json'] },
    });
    const deps = makeDeps({ client });
    const controller = new EditingController(deps);

    const result = await controller.rebaseOntoMain('ModA') as { outcome: string; conflictedPaths: string[] };

    expect(result.outcome).toBe('Conflicted');
    expect(result.conflictedPaths).toEqual(['source/Fixture.esp/npc_/000800.json']);
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
});

// ── mutation error paths ─────────────────────────────────────────────────────
// ADR-0026 "explicit action failed": the WriteRefused carries the gesture's identity token and
// the server's text, ready for the caller to show verbatim.
const mutationErrorCases: Array<{
  name: string;
  run: (c: EditingController) => Promise<unknown>;
  refusalText: string;
  errorIncludes: string;
}> = [
  { name: 'track', run: c => c.track('ModA', 'Edits'), refusalText: 'This mod folder is already tracked.', errorIncludes: 'ModA' },
  { name: 'createRecord', run: c => c.createRecord('MyPatch.esp', 'ModA', 'npc_'), refusalText: 'Unprocessable Content', errorIncludes: 'MyPatch.esp' },
  { name: 'deleteRecord', run: c => c.deleteRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA'), refusalText: 'Not Found', errorIncludes: '000801:MyPatch.esp' },
  // Covers both the untracked-referencer refusal and a partial-cascade I/O failure — both are
  // already-messaged, non-2xx responses by the time they reach renumberRecord, so they are one
  // code path here regardless of which one produced the response.
  { name: 'renumberRecord', run: c => c.renumberRecord('000801:MyPatch.esp', 'MyPatch.esp', 'ModA'), refusalText: 'Unprocessable Content', errorIncludes: '000801:MyPatch.esp' },
  { name: 'copyRecordAsOverride', run: c => c.copyRecordAsOverride('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA'), refusalText: 'Unprocessable Content', errorIncludes: '000801:Fallout4.esm' },
  { name: 'copyRecordAsNewRecord', run: c => c.copyRecordAsNewRecord('000801:Fallout4.esm', 'Fallout4.esm', 'Data', 'MyPatch.esp', 'ModA'), refusalText: 'Unprocessable Content', errorIncludes: '000801:Fallout4.esm' },
  { name: 'compile', run: c => c.compile('MyPatch.esp', 'ModA'), refusalText: 'Compile failed', errorIncludes: 'MyPatch.esp' },
  { name: 'absorbUpstreamUpdate', run: c => c.absorbUpstreamUpdate('Fixture.esp', 'ModA'), refusalText: 'git unavailable', errorIncludes: 'Fixture.esp' },
  { name: 'keepAsMyEdit', run: c => c.keepAsMyEdit('Fixture.esp', 'ModA'), refusalText: 'git unavailable', errorIncludes: 'Fixture.esp' },
  { name: 'rebaseOntoMain', run: c => c.rebaseOntoMain('ModA'), refusalText: "No loaded plugin has origin 'ModA'.", errorIncludes: 'ModA' },
  { name: 'continueRebase', run: c => c.continueRebase('ModA'), refusalText: "No loaded plugin has origin 'ModA'.", errorIncludes: 'ModA' },
];

describe('EditingController mutation error paths', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(mutationErrorCases)(
    '$name resolves a WriteRefused carrying the identity and the server text on a non-ok response',
    async ({ run, refusalText, errorIncludes }) => {
      const client = makeClient();
      client.POST = vi.fn().mockResolvedValue(drainedError(422, refusalText));
      const deps = makeDeps({ client });

      const result = asRefused(await run(new EditingController(deps)));

      expect(result.message).toContain(errorIncludes);
      expect(result.message).toContain(refusalText);
    },
  );

  it.each(mutationErrorCases)(
    '$name resolves a WriteRefused the same way for a thrown request',
    async ({ run, errorIncludes }) => {
      const client = makeClient();
      client.POST = vi.fn().mockRejectedValue(new Error('socket hang up'));
      const deps = makeDeps({ client });

      const result = asRefused(await run(new EditingController(deps)));

      expect(result.message).toContain(errorIncludes);
      expect(result.message).toContain('socket hang up');
    },
  );
});
