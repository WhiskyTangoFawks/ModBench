import { describe, it, expect, vi } from 'vitest';
import { abandonSendWhenMEditGoes, enterEditingAcrossRestarts } from '../backendStatus';
import { InMemoryMEditClient, createLoadOrderSender } from '../../client';
import { present } from '../../ports/present';

describe('abandonSendWhenMEditGoes', () => {
  it.each(['disconnected', 'stopped'] as const)('abandons the send in flight when mEdit is %s', (status) => {
    const client = new InMemoryMEditClient();
    const sender = { abandon: vi.fn() };
    abandonSendWhenMEditGoes(client, sender);

    client.setStatus(status);

    expect(sender.abandon).toHaveBeenCalledOnce();
  });

  it.each(['starting', 'running'] as const)('leaves the armed send alone while mEdit is %s, since a launch arms its send before the start', (status) => {
    const client = new InMemoryMEditClient();
    const sender = { abandon: vi.fn() };
    abandonSendWhenMEditGoes(client, sender);

    client.setStatus(status);

    expect(sender.abandon).not.toHaveBeenCalled();
  });

  it('abandons nothing once unsubscribed', () => {
    const client = new InMemoryMEditClient();
    const sender = { abandon: vi.fn() };
    const off = abandonSendWhenMEditGoes(client, sender);

    off();
    client.setStatus('disconnected');

    expect(sender.abandon).not.toHaveBeenCalled();
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
    abandonSendWhenMEditGoes(client, sender);

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
