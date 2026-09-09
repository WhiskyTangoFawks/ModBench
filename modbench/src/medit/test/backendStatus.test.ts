import { describe, it, expect, vi } from 'vitest';
import { backendStatusText, wireBackendStatus, enterEditingAcrossRestarts } from '../backendStatus';
import { InMemoryMEditClient } from '../client';
import { createLoadOrderSync, type LoadOrderSyncDeps } from '../../loadOrderReconcile';

function makeViews() {
  return { setStatusText: vi.fn(), abandonReconcile: vi.fn(), refreshTree: vi.fn() };
}

// docs/specs/medit.md § Status bar names these four verbatim; Ready is the reconcile's own.
describe('backendStatusText', () => {
  it('names each backend state the way the status bar shows it', () => {
    expect(backendStatusText('starting')).toBe('$(loading~spin) mEdit: Connecting…');
    expect(backendStatusText('attached')).toBe('$(plug) mEdit: Attached');
    expect(backendStatusText('disconnected')).toBe('$(error) mEdit: Disconnected — start MEditService and reload');
    expect(backendStatusText('stopped')).toBe('$(circle-slash) mEdit: Stopped');
  });
});

describe('wireBackendStatus', () => {
  it('writes the status bar on every change', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('attached');

    expect(views.setStatusText).toHaveBeenCalledWith('$(plug) mEdit: Attached');
  });

  // The badges the tree holds describe a backend that is gone, so it re-reads; the read fails,
  // its rows stay, and they expand into the error node.
  it('refreshes the tree when the backend goes', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('disconnected');

    expect(views.refreshTree).toHaveBeenCalled();
  });

  it('abandons an in-flight reconcile when the backend goes disconnected', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('disconnected');

    expect(views.abandonReconcile).toHaveBeenCalled();
  });

  it('abandons an in-flight reconcile when the backend stops', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('stopped');

    expect(views.abandonReconcile).toHaveBeenCalled();
  });

  // A launch arms its reconcile and only then asks the client to start, so the 'starting' that
  // start() emits must not abandon the launch that caused it.
  it('leaves the armed reconcile alone while the backend is starting', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('starting');

    expect(views.abandonReconcile).not.toHaveBeenCalled();
    expect(views.refreshTree).not.toHaveBeenCalled();
  });

  // The reconcile that follows an attach is what hands the tree its load order; reading the
  // plugin list before that PUT asks a backend that holds none.
  it('an attached backend is left to the reconcile', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('attached');

    expect(views.abandonReconcile).not.toHaveBeenCalled();
    expect(views.refreshTree).not.toHaveBeenCalled();
  });

  it('stops reporting once unsubscribed', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    const off = wireBackendStatus(client, views);

    off();
    client.setStatus('disconnected');

    expect(views.setStatusText).not.toHaveBeenCalled();
    expect(views.abandonReconcile).not.toHaveBeenCalled();
  });
});

// The whole point of the abandon: the user hears "abandoned", not a network failure they cannot
// act on, when the backend they were talking to went away mid-reconcile.
describe('a backend that disconnects mid-reconcile', () => {
  it('leaves the reconcile reporting abandoned, not failed', async () => {
    const client = new InMemoryMEditClient();
    let putStarted!: () => void;
    const started = new Promise<void>((resolve) => { putStarted = resolve; });
    const deps: LoadOrderSyncDeps = {
      debounceMs: 0,
      log: vi.fn(),
      withProgress: (work) => work(),
      say: vi.fn(),
      logInfo: vi.fn(),
      notifyNoGameDirectory: vi.fn(),
      resolveGameDirectory: () => Promise.resolve({ dataFolder: '/data' }),
      buildSnapshot: () => Promise.resolve([]),
      makeProgressHandler: () => ({ onProgress: vi.fn(), lastTotalPlugins: () => 0 }),
      // What the controller answers on each ending: a deliberate abort is 'abandoned', and a
      // refused connection would be 'failed'.
      putLoadOrder: (_plugins, _dataFolder, signal) => new Promise((resolve) => {
        putStarted();
        signal.addEventListener('abort', () => resolve({ outcome: 'abandoned' }));
      }),
      syncFilterState: () => Promise.resolve(),
      applyReconciled: () => Promise.resolve(),
      presentCrashRepairOffers: () => Promise.resolve(),
    };
    const sync = createLoadOrderSync(deps);
    wireBackendStatus(client, {
      setStatusText: vi.fn(), abandonReconcile: () => sync.abandon(), refreshTree: vi.fn(),
    });

    const outcome = sync.flush();
    await started;
    client.setStatus('disconnected');

    expect(await outcome).toBe('abandoned');
  });
});

describe('enterEditingAcrossRestarts', () => {
  it('re-enters editing when the backend attaches again after a crash', async () => {
    const client = new InMemoryMEditClient();
    const enterEditing = vi.fn().mockResolvedValue(undefined);
    enterEditingAcrossRestarts(client, enterEditing, vi.fn());

    client.setStatus('disconnected');
    client.setStatus('starting');
    client.setStatus('attached');
    await Promise.resolve();

    expect(enterEditing).toHaveBeenCalledTimes(1);
  });

  // The launch itself is what brings the backend up, so the attach it causes must not launch again.
  it('does not re-enter on the first attach', async () => {
    const client = new InMemoryMEditClient();
    const enterEditing = vi.fn().mockResolvedValue(undefined);
    const { enter } = enterEditingAcrossRestarts(client, enterEditing, vi.fn());

    await enter();
    client.setStatus('starting');
    client.setStatus('attached');
    await Promise.resolve();

    expect(enterEditing).toHaveBeenCalledTimes(1);
  });

  // A deliberate relaunch after a failed one is not a restart: its own enterEditing is the entry,
  // and the attach it causes must not stack a second one on top.
  it('does not re-enter when a deliberate relaunch follows a disconnect', async () => {
    const client = new InMemoryMEditClient();
    const enterEditing = vi.fn().mockResolvedValue(undefined);
    const { enter } = enterEditingAcrossRestarts(client, enterEditing, vi.fn());

    client.setStatus('disconnected');
    await enter();
    client.setStatus('attached');
    await Promise.resolve();

    expect(enterEditing).toHaveBeenCalledTimes(1);
  });

  it('stops re-entering once disposed', async () => {
    const client = new InMemoryMEditClient();
    const enterEditing = vi.fn().mockResolvedValue(undefined);
    const { dispose } = enterEditingAcrossRestarts(client, enterEditing, vi.fn());

    dispose();
    client.setStatus('disconnected');
    client.setStatus('attached');
    await Promise.resolve();

    expect(enterEditing).not.toHaveBeenCalled();
  });

  it('reports a re-entry that throws instead of leaving an unhandled rejection', async () => {
    const client = new InMemoryMEditClient();
    const log = vi.fn();
    enterEditingAcrossRestarts(client, () => Promise.reject(new Error('boom')), log);

    client.setStatus('disconnected');
    client.setStatus('attached');
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
