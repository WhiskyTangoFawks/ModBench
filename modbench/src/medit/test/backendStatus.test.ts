import { describe, it, expect, vi } from 'vitest';
import { backendStatusText, wireBackendStatus, enterEditingAcrossRestarts } from '../backendStatus';
import { InMemoryMEditClient, createLoadOrderSender } from '../../client';
import { present } from '../../ports/present';

function makeViews() {
  return { setStatusText: vi.fn(), abandonReconcile: vi.fn(), refreshTree: vi.fn(), setUnreachable: vi.fn() };
}

describe('backendStatusText', () => {
  it('names each backend state the way the status bar shows it', () => {
    expect(backendStatusText('starting')).toBe('$(loading~spin) mEdit: Starting…');
    expect(backendStatusText('running')).toBe('$(plug) mEdit: Running');
    expect(backendStatusText('disconnected')).toBe('$(error) mEdit: Disconnected');
    expect(backendStatusText('stopped')).toBe('$(circle-slash) mEdit: Stopped');
  });
});

describe('wireBackendStatus', () => {
  it('writes the status bar on every change', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('running');

    expect(views.setStatusText).toHaveBeenCalledWith('$(plug) mEdit: Running');
  });

  it('refreshes the tree when the backend goes, since the badges it holds describe a backend that is gone', () => {
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

  it('leaves the armed reconcile alone while the backend is starting, since a launch arms its reconcile before the start that emits starting', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('starting');

    expect(views.abandonReconcile).not.toHaveBeenCalled();
    expect(views.refreshTree).not.toHaveBeenCalled();
  });

  it('an attached backend is left to the reconcile, since the tree reading the plugin list before that PUT would ask a backend that holds no load order', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('running');

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

  it('names the tree unreachable when the backend disconnects, from the same status the bar reads', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('disconnected');

    expect(views.setUnreachable).toHaveBeenCalledWith('mEdit is disconnected.');
  });

  it('names the tree unreachable when the backend stops', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('stopped');

    expect(views.setUnreachable).toHaveBeenCalledWith('mEdit is stopped.');
  });

  it('never names the tree unreachable while the backend is starting', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('starting');

    expect(views.setUnreachable).not.toHaveBeenCalled();
  });

  it('never names the tree unreachable once attached', () => {
    const client = new InMemoryMEditClient();
    const views = makeViews();
    wireBackendStatus(client, views);

    client.setStatus('running');

    expect(views.setUnreachable).not.toHaveBeenCalled();
  });
});

describe('a backend that disconnects mid-send', () => {
  it('leaves the send reporting abandoned, not a network failure the user cannot act on (the fixture answers abandoned on a deliberate abort, where a refused connection would answer failed)', async () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    let putStarted!: () => void;
    const started = new Promise<void>((resolve) => { putStarted = resolve; });
    client.setCommandHandler('putLoadOrder', (...args) => new Promise((resolve) => {
      putStarted();
      const options = present(args[6], 'the options the sender always passes to putLoadOrder');
      const signal = present(options.signal, 'the abort signal the sender always arms');
      signal.addEventListener('abort', () => resolve({ outcome: 'abandoned' }));
    }));
    const sender = createLoadOrderSender(client);
    wireBackendStatus(client, {
      setStatusText: vi.fn(), abandonReconcile: () => sender.abandon(), refreshTree: vi.fn(), setUnreachable: vi.fn(),
    });

    const outcome = sender.send({
      plugins: [], active: [], loadedWithNoLine: [], gameDirectory: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4',
    });
    await started;
    client.setStatus('disconnected');

    expect(await outcome).toEqual({ outcome: 'abandoned' });
  });
});

describe('enterEditingAcrossRestarts', () => {
  it('re-enters editing when the backend attaches again after a crash', async () => {
    const client = new InMemoryMEditClient();
    const enterEditing = vi.fn().mockResolvedValue(undefined);
    enterEditingAcrossRestarts(client, enterEditing, vi.fn());

    client.setStatus('disconnected');
    client.setStatus('starting');
    client.setStatus('running');
    await Promise.resolve();

    expect(enterEditing).toHaveBeenCalledTimes(1);
  });

  it('does not re-enter on the first attach, which the launch itself causes', async () => {
    const client = new InMemoryMEditClient();
    const enterEditing = vi.fn().mockResolvedValue(undefined);
    const { enter } = enterEditingAcrossRestarts(client, enterEditing, vi.fn());

    await enter();
    client.setStatus('starting');
    client.setStatus('running');
    await Promise.resolve();

    expect(enterEditing).toHaveBeenCalledTimes(1);
  });

  it('does not re-enter when a deliberate relaunch follows a disconnect, since the relaunch\'s own enterEditing is the entry', async () => {
    const client = new InMemoryMEditClient();
    const enterEditing = vi.fn().mockResolvedValue(undefined);
    const { enter } = enterEditingAcrossRestarts(client, enterEditing, vi.fn());

    client.setStatus('disconnected');
    await enter();
    client.setStatus('running');
    await Promise.resolve();

    expect(enterEditing).toHaveBeenCalledTimes(1);
  });

  it('stops re-entering once disposed', async () => {
    const client = new InMemoryMEditClient();
    const enterEditing = vi.fn().mockResolvedValue(undefined);
    const { dispose } = enterEditingAcrossRestarts(client, enterEditing, vi.fn());

    dispose();
    client.setStatus('disconnected');
    client.setStatus('running');
    await Promise.resolve();

    expect(enterEditing).not.toHaveBeenCalled();
  });

  it('reports a re-entry that throws instead of leaving an unhandled rejection', async () => {
    const client = new InMemoryMEditClient();
    const log = vi.fn();
    enterEditingAcrossRestarts(client, () => Promise.reject(new Error('boom')), log);

    client.setStatus('disconnected');
    client.setStatus('running');
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
