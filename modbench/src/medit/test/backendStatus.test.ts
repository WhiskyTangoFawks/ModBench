import { describe, it, expect, vi } from 'vitest';
import { enterEditingAcrossRestarts } from '../backendStatus';
import { InMemoryMEditClient } from '../../client';

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
