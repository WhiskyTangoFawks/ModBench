import { describe, it, expect, vi } from 'vitest';
import { InMemoryMEditClient } from './InMemoryMEditClient';
import { pluginMetadataFixture } from './fixtures';

describe('InMemoryMEditClient — unscripted queries reject', () => {
  it('rejects a query with no scripted answer, rather than answering empty', async () => {
    const client = new InMemoryMEditClient();
    await expect(client.getPlugins()).rejects.toThrow(/getPlugins/);
  });
});

describe('InMemoryMEditClient — a scripted query failure', () => {
  it('answers every call with the scripted failure until re-scripted, an answer alone not clearing a standing failure', async () => {
    const client = new InMemoryMEditClient();
    const econnrefused = { failed: 'refused', refusal: 'ECONNREFUSED' } as const;
    client.setQueryFailure('getPlugins', econnrefused);

    await expect(client.getPlugins()).resolves.toEqual(econnrefused);
    await expect(client.getPlugins()).resolves.toEqual(econnrefused);

    client.setQueryAnswer('getPlugins', []);
    await expect(client.getPlugins()).resolves.toEqual(econnrefused);
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

  it('setQueryFailureOnce answers the next call with the failure, then falls back to the fixed answer', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    client.setQueryFailureOnce('getPlugins', { failed: 'refused', refusal: 'boom' });

    await expect(client.getPlugins()).resolves.toEqual({ failed: 'refused', refusal: 'boom' });
    await expect(client.getPlugins()).resolves.toEqual([]);
  });

  it('drains a mixed sequence in the order scripted — answer, then failure, then answer', async () => {
    const client = new InMemoryMEditClient();
    const first = pluginMetadataFixture({ name: 'first' });
    const retry = pluginMetadataFixture({ name: 'retry' });
    client.setQueryAnswerOnce('getPlugins', [first]);
    client.setQueryFailureOnce('getPlugins', { failed: 'refused', refusal: 'mid-sequence failure' });
    client.setQueryAnswerOnce('getPlugins', [retry]);

    await expect(client.getPlugins()).resolves.toEqual([first]);
    await expect(client.getPlugins()).resolves.toEqual({ failed: 'refused', refusal: 'mid-sequence failure' });
    await expect(client.getPlugins()).resolves.toEqual([retry]);
  });
});

describe('InMemoryMEditClient — a disconnected script', () => {
  it('is one call: status goes disconnected and every unscripted query answers unreachable', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    client.setQueryAnswer('getDiagnoses', []);

    client.disconnected();

    expect(client.status).toBe('disconnected');
    await expect(client.getPlugins()).resolves.toEqual({ failed: 'unreachable' });
    await expect(client.getDiagnoses()).resolves.toEqual({ failed: 'unreachable' });
  });

  it('clears a scripted failure too, not just a fixed answer, so a disconnected read answers unreachable rather than a stale reason', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getPlugins', { failed: 'refused', refusal: 'ECONNREFUSED' });

    client.disconnected();

    await expect(client.getPlugins()).resolves.toEqual({ failed: 'unreachable' });
  });
});

describe('InMemoryMEditClient — status', () => {
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
