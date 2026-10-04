import { describe, it, expect, vi } from 'vitest';
import { InMemoryMEditClient } from '../InMemoryMEditClient';
import { pluginMetadataFixture, notificationEventFixture } from './fixtures';

describe('InMemoryMEditClient — recorded calls', () => {
  it('records a query call with its arguments', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    await client.getReferences('000001:Fallout4.esm');
    expect(client.calls).toContainEqual({ method: 'getReferences', args: ['000001:Fallout4.esm'] });
  });

  it('records a command call with its arguments', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [], refused: [] });
    await client.compile([{ name: 'MyMod.esp', origin: 'MyMod' }]);
    expect(client.calls).toContainEqual({ method: 'compile', args: [[{ name: 'MyMod.esp', origin: 'MyMod' }]] });
  });
});

describe('InMemoryMEditClient — unscripted queries reject', () => {
  it('rejects a query with no scripted answer, rather than answering empty', async () => {
    const client = new InMemoryMEditClient();
    await expect(client.getPlugins()).rejects.toThrow(/getPlugins/);
  });

  it('does not fall back to an empty answer once scripted, only before, so a test that forgot to script it fails rather than rendering a plausible but wrong tree', async () => {
    const client = new InMemoryMEditClient();
    await expect(client.getDiagnoses()).rejects.toThrow();
    client.setQueryAnswer('getDiagnoses', []);
    await expect(client.getDiagnoses()).resolves.toEqual([]);
  });
});

describe('InMemoryMEditClient — a scripted query failure', () => {
  it('rejects every call with the scripted error until re-scripted, an answer alone not clearing a standing failure', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getPlugins', new Error('ECONNREFUSED'));

    await expect(client.getPlugins()).rejects.toThrow('ECONNREFUSED');
    await expect(client.getPlugins()).rejects.toThrow('ECONNREFUSED');

    client.setQueryAnswer('getPlugins', []);
    await expect(client.getPlugins()).rejects.toThrow('ECONNREFUSED');
  });
});

describe('InMemoryMEditClient — a queued once-form script', () => {
  it('setQueryAnswerOnce answers the next call, then falls back to the fixed answer', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const scripted = pluginMetadataFixture({ name: 'A.esp' });
    client.setQueryAnswerOnce('getPlugins', [scripted]);

    await expect(client.getPlugins()).resolves.toEqual([scripted]);
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
    const first = pluginMetadataFixture({ name: 'first' });
    const retry = pluginMetadataFixture({ name: 'retry' });
    client.setQueryAnswerOnce('getPlugins', [first]);
    client.setQueryFailureOnce('getPlugins', new Error('mid-sequence failure'));
    client.setQueryAnswerOnce('getPlugins', [retry]);

    await expect(client.getPlugins()).resolves.toEqual([first]);
    await expect(client.getPlugins()).rejects.toThrow('mid-sequence failure');
    await expect(client.getPlugins()).resolves.toEqual([retry]);
  });
});

describe('InMemoryMEditClient — a scripted command failure', () => {
  it('rejects every call with the scripted error until re-scripted', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandFailure('compile', new Error('the compile step failed'));

    await expect(client.compile([{ name: 'MyMod.esp', origin: 'MyMod' }])).rejects.toThrow('the compile step failed');

    client.setCommandResult('compile', { landed: [], refused: [] });
    await expect(client.compile([{ name: 'MyMod.esp', origin: 'MyMod' }])).rejects.toThrow('the compile step failed');
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

  it('clears a scripted failure too, not just a fixed answer, so a disconnected read rejects with the adapter\'s own generic reason rather than a stale one', async () => {
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
    client.setStatus('running');
    expect(client.status).toBe('running');
  });

  it('notifies onStatusChanged listeners, and unsubscribe stops further notice', () => {
    const client = new InMemoryMEditClient();
    const listener = vi.fn();
    const unsubscribe = client.onStatusChanged(listener);
    client.setStatus('running');
    expect(listener).toHaveBeenCalledWith('running');
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
    const event = notificationEventFixture({ kind: 'rows-changed' });
    client.emit(event);
    expect(rowsListener).toHaveBeenCalledWith(event);
    expect(pluginListener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops further dispatch', () => {
    const client = new InMemoryMEditClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribe('track-progress', listener);
    unsubscribe();
    client.emit(notificationEventFixture({ kind: 'track-progress' }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('InMemoryMEditClient — latestLoadOrderPut', () => {
  it('is none before any put, then the outcome of the latest put', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandHandler('putLoadOrder', () => Promise.resolve({ outcome: 'failed', message: 'later' }));
    await expect(client.latestLoadOrderPut()).resolves.toBeUndefined();

    void client.putLoadOrder([], [], [], '/game/Data', '/instance', 'Fallout4');

    await expect(client.latestLoadOrderPut()).resolves.toEqual({ outcome: 'failed', message: 'later' });
  });
});
