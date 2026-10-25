import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SseNotificationSubscriber } from '../notificationStream';
import type { NotificationKind } from '../MEditClient';
import type { NotificationEvent } from '../apiClient';
import { IGNORED_THROWS, notificationEventFixture, recordedThrows } from './fixtures';
import { leveledLog } from '../../test/leveledLog';
import { present } from '../../ports/present';

function rowsChanged(keys: string[], overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return notificationEventFixture({ kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys, ...overrides });
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

const unopened = () => new SseNotificationSubscriber({ openStream: () => Promise.reject(new Error('never opened')), listenerThrows: IGNORED_THROWS });

describe('SseNotificationSubscriber', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispatches an event frame and skips a comment-only one', async () => {
    const event = rowsChanged(['000001:Test.esp']);
    const openStream = vi.fn().mockResolvedValue(streamResponse([commentFrame(), sseFrame(event)]));
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream });
    const received: unknown[] = [];
    subscriber.onNotification('rows-changed', (p) => received.push(p));

    subscriber.start();
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toEqual({ plugin: { name: event.plugin, origin: event.origin }, keys: event.keys });
    subscriber.stop();
  });

  it('carries the mods a mod-status-changed frame names through the stream', async () => {
    const event = rowsChanged([], { kind: 'mod-status-changed', mods: ['ModA'] });
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream: vi.fn().mockResolvedValue(streamResponse([sseFrame(event)])) });
    const received: unknown[] = [];
    subscriber.onNotification('mod-status-changed', (p) => received.push(p));

    subscriber.start();
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received).toEqual([{ mods: ['ModA'] }]);
    subscriber.stop();
  });

  it.each([
    ['the stream ends', () => Promise.resolve(streamResponse([]))],
    ['a malformed frame, without dispatching it', () => Promise.resolve(streamResponse([frameOfValidJsonMissingTheFieldsAnEventRequires()]))],
    ['openStream itself rejects', () => Promise.reject(new Error('ECONNREFUSED'))],
  ])('reconnects after %s, without a live backend, as a one-shot adapter would be silently killed by a hiccup for the rest of the session', async (_, firstAttempt) => {
    const openStream = vi.fn()
      .mockImplementationOnce(firstAttempt)
      .mockResolvedValueOnce(streamResponse([sseFrame(rowsChanged(['000002:Other.esp']))]));
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream, reconnectDelayMs: 1000 });
    const received: unknown[] = [];
    subscriber.onNotification('rows-changed', (p) => received.push(p));

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(openStream).toHaveBeenCalledTimes(2);
    expect(received).toEqual([{ plugin: { name: 'Test.esp', origin: 'ModA' }, keys: ['000002:Other.esp'] }]);
    subscriber.stop();
  });

  it('a throwing listener is reported as thrown and does not drop the stream, and the listeners after it hear the frame', async () => {
    const openStream = vi.fn().mockResolvedValue(streamResponse([sseFrame(rowsChanged(['000001:Test.esp']))]));
    const log = leveledLog();
    const { sink, threw } = recordedThrows();
    const subscriber = new SseNotificationSubscriber({ openStream, log, listenerThrows: sink, reconnectDelayMs: 1000 });
    const heard: unknown[] = [];
    subscriber.onNotification('rows-changed', () => { throw new Error('listener broke'); });
    subscriber.onNotification('rows-changed', (p) => heard.push(p));

    subscriber.start();
    await vi.waitFor(() => expect(log.lines.info).toContain('[notifications] stream ended; reconnecting'));

    expect(heard).toHaveLength(1);
    expect(threw.map((t) => t.detail)).toEqual(['listener broke']);
    expect(log.lines.warn.join('\n')).not.toContain('stream dropped');
    subscriber.stop();
  });

  it('says a listener recovered once a call of it that threw is followed by one that returns', async () => {
    const frames = [sseFrame(rowsChanged(['a'])), sseFrame(rowsChanged(['b']))];
    const openStream = vi.fn().mockResolvedValue(streamResponse(frames));
    const log = leveledLog();
    const { sink, threw, recovered } = recordedThrows();
    const subscriber = new SseNotificationSubscriber({ openStream, log, listenerThrows: sink, reconnectDelayMs: 1000 });
    const listener = vi.fn().mockImplementationOnce(() => { throw new Error('once'); });
    subscriber.onNotification('rows-changed', listener);

    subscriber.start();
    await vi.waitFor(() => expect(log.lines.info).toContain('[notifications] stream ended; reconnecting'));

    expect(threw).toHaveLength(1);
    expect(recovered).toEqual([listener]);
    subscriber.stop();
  });

  it('a throwing reopen listener is reported as thrown and does not drop the stream, and the listeners after it hear the reopen', async () => {
    const openStream = vi.fn().mockImplementation(() => Promise.resolve(streamResponse([])));
    const log = leveledLog();
    const { sink, threw } = recordedThrows();
    const subscriber = new SseNotificationSubscriber({ openStream, log, listenerThrows: sink, reconnectDelayMs: 1000 });
    const heard = vi.fn();
    subscriber.onReconnected(() => { throw new Error('reopen listener broke'); });
    subscriber.onReconnected(heard);

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(log.lines.info).toHaveLength(2));

    expect(heard).toHaveBeenCalledTimes(1);
    expect(threw.map((t) => t.detail)).toEqual(['reopen listener broke']);
    expect(log.lines.warn.join('\n')).not.toContain('stream dropped');
    subscriber.stop();
  });

  it('aborts the attempt when a malformed frame drops it, so the connection does not stay open', async () => {
    const signals: AbortSignal[] = [];
    const openStream = vi.fn().mockImplementation((signal: AbortSignal) => {
      signals.push(signal);
      return Promise.resolve(streamResponse([frameOfValidJsonMissingTheFieldsAnEventRequires()]));
    });
    const log = leveledLog();
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream, log, reconnectDelayMs: 100_000 });

    subscriber.start();
    await vi.waitFor(() => expect(log.lines.warn.join('\n')).toContain('stream dropped'));

    expect(signals[0]?.aborted).toBe(true);
    subscriber.stop();
  });

  it('start() is idempotent — a second call while running opens no second stream', async () => {
    const openStream = vi.fn().mockResolvedValue(streamResponse([]));
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream, reconnectDelayMs: 100_000 });

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    subscriber.start();

    expect(openStream).toHaveBeenCalledTimes(1);
    subscriber.stop();
  });

  it('start() after a stop() taken between attempts opens one stream at once, not a delayed pair, the sleeping loop not waking on its own beside a second loop', async () => {
    const openStream = vi.fn().mockResolvedValue(streamResponse([]));
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream, reconnectDelayMs: 2000 });

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
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream });
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
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream, reconnectDelayMs: 100_000 });
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
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream, reconnectDelayMs: 1000 });
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
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream, reconnectDelayMs: 1000 });
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
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream, reconnectDelayMs: 1000 });
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
    const subscriber = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream, reconnectDelayMs: 1000 });

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
  const modlistProgress: NotificationEvent['modlistProgress'] = { mod: 'ModA', modsDone: 1, modsTotal: 2 };
  const changedPlugins = [{ name: 'A.esp', bytesSha256: 'abc' }];

  const cases: [NotificationKind, NotificationEvent, unknown][] = [
    ['load-order-status', rowsChanged([], { kind: 'load-order-status', loadOrderStatus }), {
      totalPlugins: 3, activePlugins: 2, version: 4, indexedPlugins: [{ name: 'A.esp', origin: 'ModA' }], conflictsComputed: true, failures: [], holdsNone: false,
    }],
    ['decompile-and-commit-progress', rowsChanged([], { kind: 'decompile-and-commit-progress', modlistProgress, decompileAndCommitPhase: 'Parsing' }), { ...modlistProgress, phase: 'Parsing' }],
    ['update-manifest-progress', rowsChanged([], { kind: 'update-manifest-progress', modlistProgress }), modlistProgress],
    ['restore-from-manifest-progress', rowsChanged([], { kind: 'restore-from-manifest-progress', modlistProgress }), modlistProgress],
    ['external-change', rowsChanged([], { kind: 'external-change', changedPlugins }), { origin: 'ModA', changedPlugins }],
    ['plugin-source-unreadable', rowsChanged([], { kind: 'plugin-source-unreadable', pluginWithUnreadableSources: [{ name: 'A.esp', source: { reason: 'Gone.', decompileRepairs: true } }] }),
      { plugins: [{ name: 'A.esp', origin: 'ModA', reason: 'Gone.', decompileRepairs: true }] }],
    ['record-filter-cleared', rowsChanged([], { kind: 'record-filter-cleared', recordFilterCleared: { source: 'a.sql', reason: 'boom' } }), { source: 'a.sql', reason: 'boom' }],
    ['rows-changed', rowsChanged(['000001:Test.esp']), { plugin: { name: 'Test.esp', origin: 'ModA' }, keys: ['000001:Test.esp'] }],
    ['plugin-changed', rowsChanged([], { kind: 'plugin-changed' }), { plugin: { name: 'Test.esp', origin: 'ModA' } }],
    ['mod-status-changed', rowsChanged([], { kind: 'mod-status-changed', mods: ['ModA', 'ModB'] }), { mods: ['ModA', 'ModB'] }],
  ];

  function listenToEveryKind(subscriber: SseNotificationSubscriber): unknown[] {
    const heard: unknown[] = [];
    cases.map(([kind]) => subscriber.onNotification(kind, (p) => heard.push([kind, p])));
    return heard;
  }

  it.each(cases)('hands a %s listener its kind\'s payload, and no listener of another kind anything', (kind, event, payload) => {
    const subscriber = unopened();
    const heard = listenToEveryKind(subscriber);

    subscriber.dispatch(event);

    expect(heard).toEqual([[kind, payload]]);
  });

  it('gives an external-change frame without changedPlugins an empty list', () => {
    const subscriber = unopened();
    const heard: unknown[] = [];
    subscriber.onNotification('external-change', (p) => heard.push(p));

    subscriber.dispatch(rowsChanged([], { kind: 'external-change' }));

    expect(heard).toEqual([{ origin: 'ModA', changedPlugins: [] }]);
  });

  it.each(['load-order-status', 'decompile-and-commit-progress', 'update-manifest-progress', 'restore-from-manifest-progress'] as const)('skips a %s frame missing its payload', (kind) => {
    const subscriber = unopened();
    const heard: unknown[] = [];
    subscriber.onNotification(kind, (p) => heard.push(p));

    subscriber.dispatch(rowsChanged([], { kind }));

    expect(heard).toEqual([]);
  });

  it('unsubscribe stops a typed listener', () => {
    const subscriber = unopened();
    const typed: unknown[] = [];
    const off = subscriber.onNotification('plugin-changed', (p) => typed.push(p));

    subscriber.dispatch(rowsChanged([], { kind: 'plugin-changed' }));
    off();
    subscriber.dispatch(rowsChanged([], { kind: 'plugin-changed' }));

    expect(typed).toHaveLength(1);
  });
});
