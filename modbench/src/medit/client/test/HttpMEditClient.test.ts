import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';

vi.mock('node:http');

import { HttpMEditClient } from '../HttpMEditClient';
import type { EditingController } from '../../EditingController';
import type { PluginRepository } from '../../PluginRepository';
import { FakeNotificationSubscriber } from '../../NotificationSubscriber';

function makeSubscriber() {
  const fake = new FakeNotificationSubscriber();
  return Object.assign(fake, { start: vi.fn(), stop: vi.fn() });
}

function makeClient(subscriber = makeSubscriber(), health: 'up' | 'down' = 'up') {
  vi.mocked(http.get).mockImplementation((_url: any, cb: any) => {
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    if (health === 'up') cb(Object.assign(new EventEmitter(), { statusCode: 200 }));
    else process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
    return req as any;
  });
  const client = new HttpMEditClient({
    controller: {} as EditingController,
    repository: {} as PluginRepository,
    notificationSubscriber: subscriber,
    backend: { port: 5172, pollIntervalMs: 5, pollTimeoutMs: 20 },
  });
  return { client, subscriber };
}

describe('HttpMEditClient — the process is the client\'s own', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // A cached copy of a push-only event can disagree with the process it describes; the lifecycle
  // is inside this client, so the read is the process's own.
  it('reads the lifecycle\'s own status, not a cached copy of it', async () => {
    const { client } = makeClient();
    expect(client.status).toBe('starting');

    await client.start();

    expect(client.status).toBe('attached');
  });

  it('reports every status change to its listeners', async () => {
    const { client } = makeClient();
    const seen: string[] = [];
    client.onStatusChanged((s) => seen.push(s));

    await client.start();
    await client.stop();

    expect(seen).toEqual(['attached', 'stopped']);
  });

  it('an unsubscribed listener hears nothing more', async () => {
    const { client } = makeClient();
    const seen: string[] = [];
    const off = client.onStatusChanged((s) => seen.push(s));

    await client.start();
    off();
    await client.stop();

    expect(seen).toEqual(['attached']);
  });
});

// ADR-0046 invariant 12: the subscription follows the backend, and only this module drives it.
describe('HttpMEditClient — the notification stream follows the status', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens the stream when the backend attaches', async () => {
    const { client, subscriber } = makeClient();
    expect(subscriber.start).not.toHaveBeenCalled();

    await client.start();

    expect(subscriber.start).toHaveBeenCalled();
  });

  it('closes the stream when the backend stops', async () => {
    const { client, subscriber } = makeClient();
    await client.start();

    await client.stop();

    expect(subscriber.stop).toHaveBeenCalled();
  });

  it('closes the stream when the backend goes disconnected', async () => {
    const { client, subscriber } = makeClient(makeSubscriber(), 'down');

    await client.start();

    expect(client.status).toBe('disconnected');
    expect(subscriber.stop).toHaveBeenCalled();
    expect(subscriber.start).not.toHaveBeenCalled();
  });
});
