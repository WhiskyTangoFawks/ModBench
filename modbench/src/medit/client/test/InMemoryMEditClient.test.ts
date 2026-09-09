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

describe('InMemoryMEditClient — a scripted query failure', () => {
  it('rejects every call with the scripted error until re-scripted', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getPlugins', new Error('ECONNREFUSED'));

    await expect(client.getPlugins()).rejects.toThrow('ECONNREFUSED');
    await expect(client.getPlugins()).rejects.toThrow('ECONNREFUSED');

    client.setQueryAnswer('getPlugins', []);
    // A fixed failure reads before a fixed answer in `query()`'s own order, so this still
    // rejects — an answer alone does not clear a standing failure.
    await expect(client.getPlugins()).rejects.toThrow('ECONNREFUSED');
  });
});

describe('InMemoryMEditClient — a queued once-form script', () => {
  it('setQueryAnswerOnce answers the next call, then falls back to the fixed answer', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    client.setQueryAnswerOnce('getPlugins', [{ name: 'A.esp' } as never]);

    await expect(client.getPlugins()).resolves.toEqual([{ name: 'A.esp' }]);
    await expect(client.getPlugins()).resolves.toEqual([]);
  });

  it('setQueryFailureOnce rejects the next call, then falls back to the fixed answer', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    client.setQueryFailureOnce('getPlugins', new Error('boom'));

    await expect(client.getPlugins()).rejects.toThrow('boom');
    await expect(client.getPlugins()).resolves.toEqual([]);
  });

  it('drains a mixed sequence in the order scripted — answer, then failure, then answer', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswerOnce('getPlugins', [{ name: 'first' } as never]);
    client.setQueryFailureOnce('getPlugins', new Error('mid-sequence failure'));
    client.setQueryAnswerOnce('getPlugins', [{ name: 'retry' } as never]);

    await expect(client.getPlugins()).resolves.toEqual([{ name: 'first' }]);
    await expect(client.getPlugins()).rejects.toThrow('mid-sequence failure');
    await expect(client.getPlugins()).resolves.toEqual([{ name: 'retry' }]);
  });
});

describe('InMemoryMEditClient — a scripted command failure', () => {
  it('rejects every call with the scripted error until re-scripted', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandFailure('compile', new Error('write gate busy'));

    await expect(client.compile('MyMod.esp', 'MyMod', 'HEAD')).rejects.toThrow('write gate busy');

    client.setCommandResult('compile', undefined);
    await expect(client.compile('MyMod.esp', 'MyMod', 'HEAD')).rejects.toThrow('write gate busy');
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

  // The rival this guards: clearing only fixed answers leaves a scripted failure standing, so a
  // disconnected read rejects with that stale reason instead of the adapter's own generic one.
  it('clears a scripted failure too, not just a fixed answer', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getPlugins', new Error('ECONNREFUSED'));

    client.disconnected();

    await expect(client.getPlugins()).rejects.toThrow(/no scripted answer for query "getPlugins"/);
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
