import { describe, it, expect, vi } from 'vitest';
import { InMemoryMEditClient } from '../InMemoryMEditClient';
import type { NotificationEvent } from '../MEditClient';

describe('InMemoryMEditClient — recorded calls', () => {
  it('records a query call with its arguments', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    await client.getReferences('000001:Fallout4.esm');
    expect(client.calls).toContainEqual({ method: 'getReferences', args: ['000001:Fallout4.esm'] });
  });

  it('records a command call with its arguments', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', undefined);
    await client.compile('MyMod.esp', 'MyMod', 'HEAD');
    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyMod.esp', 'MyMod', 'HEAD'] });
  });
});

describe('InMemoryMEditClient — unscripted queries reject', () => {
  it('rejects a query with no scripted answer, rather than answering empty', async () => {
    const client = new InMemoryMEditClient();
    await expect(client.getPlugins()).rejects.toThrow(/getPlugins/);
  });

  // The rival: silently falling back to an empty array/undefined would render a plausible but
  // wrong tree instead of failing the test that forgot to script it.
  it('does not fall back to an empty answer once scripted, only before', async () => {
    const client = new InMemoryMEditClient();
    await expect(client.getDiagnoses()).rejects.toThrow();
    client.setQueryAnswer('getDiagnoses', []);
    await expect(client.getDiagnoses()).resolves.toEqual([]);
  });
});

describe('InMemoryMEditClient — a disconnected script', () => {
  it('is one call: status goes disconnected and every query rejects', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    client.setQueryAnswer('getDiagnoses', []);

    client.disconnected();

    expect(client.status).toBe('disconnected');
    await expect(client.getPlugins()).rejects.toThrow();
    await expect(client.getDiagnoses()).rejects.toThrow();
  });
});

describe('InMemoryMEditClient — status', () => {
  it('starts as "starting" and is settable', () => {
    const client = new InMemoryMEditClient();
    expect(client.status).toBe('starting');
    client.setStatus('attached');
    expect(client.status).toBe('attached');
  });

  it('notifies onStatusChanged listeners, and unsubscribe stops further notice', () => {
    const client = new InMemoryMEditClient();
    const listener = vi.fn();
    const unsubscribe = client.onStatusChanged(listener);
    client.setStatus('attached');
    expect(listener).toHaveBeenCalledWith('attached');
    unsubscribe();
    client.setStatus('stopped');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('InMemoryMEditClient — subscribe/emit', () => {
  it('dispatches an emitted event only to listeners of its own kind', () => {
    const client = new InMemoryMEditClient();
    const rowsListener = vi.fn();
    const pluginListener = vi.fn();
    client.subscribe('rows-changed', rowsListener);
    client.subscribe('plugin-changed', pluginListener);
    const event = { kind: 'rows-changed' } as NotificationEvent;
    client.emit(event);
    expect(rowsListener).toHaveBeenCalledWith(event);
    expect(pluginListener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops further dispatch', () => {
    const client = new InMemoryMEditClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribe('track-progress', listener);
    unsubscribe();
    client.emit({ kind: 'track-progress' } as NotificationEvent);
    expect(listener).not.toHaveBeenCalled();
  });
});
