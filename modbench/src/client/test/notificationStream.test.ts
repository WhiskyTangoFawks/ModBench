import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SseNotificationSubscriber } from '../notificationStream';
import { toLoadOrderStatus } from '../apiClient';
import type { NotificationKind } from '../MEditClient';
import type { NotificationEvent } from '../apiClient';
import { present } from '../../ports/present';

function rowsChanged(keys: string[], overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return { kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys, sequence: 1, ...overrides };
}

function sseFrame(event: NotificationEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
}

function commentFrame(): Uint8Array {
  return new TextEncoder().encode(': connected\n\n');
}

function frameOfValidJsonMissingTheFieldsAnEventRequires(): Uint8Array {
  return new TextEncoder().encode('event: rows-changed\ndata: {"kind":"rows-changed"}\n\n');
}

function scriptedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function streamResponse(chunks: Uint8Array[]): Response {
  return new Response(scriptedStream(chunks), { status: 200 });
}

class TestableSubscriber extends SseNotificationSubscriber {
  constructor() { super({ openStream: () => Promise.reject(new Error('never opened')) }); }
  receive(event: NotificationEvent): void { this.dispatch(event); }
}

describe('SseNotificationSubscriber', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispatches an event frame and skips a comment-only one', async () => {
    const event = rowsChanged(['000001:Test.esp']);
    const openStream = vi.fn().mockResolvedValue(streamResponse([commentFrame(), sseFrame(event)]));
    const subscriber = new SseNotificationSubscriber({ openStream });
    const received: unknown[] = [];
    subscriber.onNotification('rows-changed', (p) => received.push(p));

    subscriber.start();
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toEqual({ plugin: event.plugin, origin: event.origin, keys: event.keys });
    subscriber.stop();
  });

  it('reconnects after the stream ends, without a live backend, as a one-shot adapter would be silently killed by a hiccup for the rest of the session', async () => {
    const secondEvent = rowsChanged(['000002:Other.esp']);
    const openStream = vi.fn()
      .mockResolvedValueOnce(streamResponse([]))
      .mockResolvedValueOnce(streamResponse([sseFrame(secondEvent)]));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 1000 });
    const received: unknown[] = [];
    subscriber.onNotification('rows-changed', (p) => received.push(p));

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(openStream).toHaveBeenCalledTimes(2);
    expect(received[0]).toEqual({ plugin: secondEvent.plugin, origin: secondEvent.origin, keys: secondEvent.keys });
    subscriber.stop();
  });

  it('reconnects after a malformed frame, without dispatching it', async () => {
    const goodEvent = rowsChanged(['000002:Other.esp']);
    const openStream = vi.fn()
      .mockResolvedValueOnce(streamResponse([frameOfValidJsonMissingTheFieldsAnEventRequires()]))
      .mockResolvedValueOnce(streamResponse([sseFrame(goodEvent)]));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 1000 });
    const received: unknown[] = [];
    subscriber.onNotification('rows-changed', (p) => received.push(p));

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(openStream).toHaveBeenCalledTimes(2);
    expect(received[0]).toEqual({ plugin: goodEvent.plugin, origin: goodEvent.origin, keys: goodEvent.keys });
    subscriber.stop();
  });

  it('reconnects after openStream itself rejects', async () => {
    const event = rowsChanged(['000001:Test.esp']);
    const openStream = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(streamResponse([sseFrame(event)]));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 500 });
    const received: unknown[] = [];
    subscriber.onNotification('rows-changed', (p) => received.push(p));

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    subscriber.stop();
  });

  it('start() is idempotent — a second call while running opens no second stream', async () => {
    const openStream = vi.fn().mockResolvedValue(streamResponse([]));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 100_000 });

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    subscriber.start();

    expect(openStream).toHaveBeenCalledTimes(1);
    subscriber.stop();
  });

  it('start() after a stop() taken between attempts opens one stream at once, not a delayed pair, the sleeping loop not waking on its own beside a second loop', async () => {
    const openStream = vi.fn().mockResolvedValue(streamResponse([]));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 2000 });

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    subscriber.stop();
    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(2000);
    expect(openStream).toHaveBeenCalledTimes(3);
    subscriber.stop();
  });

  it('whenConnected() settles only once the stream has answered', async () => {
    let answer: ((response: Response) => void) | undefined;
    const openStream = vi.fn().mockImplementation(() => new Promise<Response>((r) => { answer = r; }));
    const subscriber = new SseNotificationSubscriber({ openStream });
    let connected = false;

    subscriber.start();
    void subscriber.whenConnected().then(() => { connected = true; });
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    expect(connected).toBe(false);

    present(answer, 'the promise-settling connection callback')(streamResponse([]));
    await vi.waitFor(() => expect(connected).toBe(true));
    subscriber.stop();
  });

  it('whenConnected() settles when the attempt fails, so the caller goes on without progress rather than waiting for a stream it will never get', async () => {
    const openStream = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 100_000 });
    let connected = false;

    subscriber.start();
    void subscriber.whenConnected().then(() => { connected = true; });
    await vi.waitFor(() => expect(connected).toBe(true));

    subscriber.stop();
  });

  it('announces a reopen after a drop, and not the first open, as a backend the client attached to without owning it can restart under a live status', async () => {
    const openStream = vi.fn()
      .mockResolvedValueOnce(streamResponse([]))
      .mockResolvedValueOnce(streamResponse([]))
      .mockResolvedValue(new Response(new ReadableStream(), { status: 200 }));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 1000 });
    const reconnects = vi.fn();
    subscriber.onReconnected(reconnects);

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    expect(reconnects).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(openStream).toHaveBeenCalledTimes(3);
    expect(reconnects).toHaveBeenCalledTimes(2);
    subscriber.stop();
  });

  it('announces no reopen for the first open after a stop and start', async () => {
    const openStream = vi.fn().mockResolvedValue(new Response(new ReadableStream(), { status: 200 }));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 1000 });
    const reconnects = vi.fn();
    subscriber.onReconnected(reconnects);

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    subscriber.stop();
    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(2));

    expect(reconnects).not.toHaveBeenCalled();
    subscriber.stop();
  });

  it('announces no reopen for an attempt that failed', async () => {
    const openStream = vi.fn()
      .mockResolvedValueOnce(streamResponse([]))
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 1000 });
    const reconnects = vi.fn();
    subscriber.onReconnected(reconnects);

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);

    expect(openStream).toHaveBeenCalledTimes(2);
    expect(reconnects).not.toHaveBeenCalled();
    subscriber.stop();
  });

  it('stop() aborts the in-flight attempt and stops retrying', async () => {
    let sawSignal: AbortSignal | undefined;
    const openStream = vi.fn().mockImplementation((signal: AbortSignal) => {
      sawSignal = signal;
      return new Promise<Response>(() => {});
    });
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 1000 });

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    subscriber.stop();

    expect(sawSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openStream).toHaveBeenCalledTimes(1);
  });
});

describe('SseNotificationSubscriber — typed listeners', () => {
  const loadOrderStatus: NotificationEvent['loadOrderStatus'] = {
    state: 'Ready', totalPlugins: 3, activePlugins: 2, indexedPlugins: [{ name: 'A.esp', origin: 'ModA' }],
    conflictsComputed: true, failures: [], version: 4,
  };
  const trackProgress: NotificationEvent['trackProgress'] = { mod: 'ModA', phase: 'Parsing', pluginsDone: 1, pluginsTotal: 2 };
  const changedPlugins = [{ name: 'A.esp', bytesSha256: 'abc' }];

  const cases: [NotificationKind, NotificationEvent, unknown][] = [
    ['load-order-status', rowsChanged([], { kind: 'load-order-status', loadOrderStatus }), toLoadOrderStatus(loadOrderStatus)],
    ['track-progress', rowsChanged([], { kind: 'track-progress', trackProgress }), trackProgress],
    ['external-change', rowsChanged([], { kind: 'external-change', changedPlugins }), { origin: 'ModA', changedPlugins }],
    ['untracked-plugins', rowsChanged(['A.esp', 'B.esp'], { kind: 'untracked-plugins' }), { origin: 'ModA', plugins: ['A.esp', 'B.esp'] }],
    ['rows-changed', rowsChanged(['000001:Test.esp']), { plugin: 'Test.esp', origin: 'ModA', keys: ['000001:Test.esp'] }],
    ['plugin-changed', rowsChanged([], { kind: 'plugin-changed' }), { plugin: 'Test.esp', origin: 'ModA' }],
  ];

  it.each(cases)('hands a %s listener its kind\'s payload', (kind, event, payload) => {
    const subscriber = new TestableSubscriber();
    const heard: unknown[] = [];
    subscriber.onNotification(kind, (p) => heard.push(p));

    subscriber.receive(event);

    expect(heard).toEqual([payload]);
  });

  it('gives an external-change frame without changedPlugins an empty list', () => {
    const subscriber = new TestableSubscriber();
    const heard: unknown[] = [];
    subscriber.onNotification('external-change', (p) => heard.push(p));

    subscriber.receive(rowsChanged([], { kind: 'external-change' }));

    expect(heard).toEqual([{ origin: 'ModA', changedPlugins: [] }]);
  });

  it.each(['load-order-status', 'track-progress'] as const)('skips a %s frame missing its payload', (kind) => {
    const subscriber = new TestableSubscriber();
    const heard: unknown[] = [];
    subscriber.onNotification(kind, (p) => heard.push(p));

    subscriber.receive(rowsChanged([], { kind }));

    expect(heard).toEqual([]);
  });

  it('unsubscribe stops a typed listener', () => {
    const subscriber = new TestableSubscriber();
    const typed: unknown[] = [];
    const off = subscriber.onNotification('plugin-changed', (p) => typed.push(p));

    subscriber.receive(rowsChanged([], { kind: 'plugin-changed' }));
    off();
    subscriber.receive(rowsChanged([], { kind: 'plugin-changed' }));

    expect(typed).toHaveLength(1);
  });
});
