import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SseNotificationSubscriber } from '../notificationStream';
import type { NotificationEvent } from '../apiClient';

function rowsChanged(keys: string[], overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return { kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys, sequence: 1, ...overrides };
}

function sseFrame(event: NotificationEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
}

function commentFrame(): Uint8Array {
  return new TextEncoder().encode(': connected\n\n');
}

// Enqueues every chunk up front, then closes — a stream whose whole life is scripted at
// construction, standing in for one real fetch response.
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

describe('SseNotificationSubscriber', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispatches an event frame and skips a comment-only one', async () => {
    const event = rowsChanged(['000001:Test.esp']);
    const openStream = vi.fn().mockResolvedValue(streamResponse([commentFrame(), sseFrame(event)]));
    const subscriber = new SseNotificationSubscriber({ openStream });
    const received: NotificationEvent[] = [];
    subscriber.subscribe('rows-changed', (e) => received.push(e));

    subscriber.start();
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toEqual(event);
    subscriber.stop();
  });

  it('reconnects after the stream ends, without a live backend', async () => {
    // The rival this guards against: a `start()` that opens the stream once and never retries —
    // a one-shot adapter that a hiccup would silently kill for the rest of the session.
    const secondEvent = rowsChanged(['000002:Other.esp']);
    const openStream = vi.fn()
      .mockResolvedValueOnce(streamResponse([])) // ends immediately — the drop
      .mockResolvedValueOnce(streamResponse([sseFrame(secondEvent)]));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 1000 });
    const received: NotificationEvent[] = [];
    subscriber.subscribe('rows-changed', (e) => received.push(e));

    subscriber.start();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(openStream).toHaveBeenCalledTimes(2);
    expect(received[0]).toEqual(secondEvent);
    subscriber.stop();
  });

  it('reconnects after openStream itself rejects', async () => {
    const event = rowsChanged(['000001:Test.esp']);
    const openStream = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(streamResponse([sseFrame(event)]));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 500 });
    const received: NotificationEvent[] = [];
    subscriber.subscribe('rows-changed', (e) => received.push(e));

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

  // The rival: a stop()/start() pair that leaves the sleeping loop to wake on its own. The
  // restart then opens nothing for a whole reconnect delay, and wakes a second loop beside it.
  it('start() after a stop() taken between attempts opens one stream at once, not a delayed pair', async () => {
    const openStream = vi.fn().mockResolvedValue(streamResponse([])); // ends at once — straight to the sleep
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

    answer!(streamResponse([]));
    await vi.waitFor(() => expect(connected).toBe(true));
    subscriber.stop();
  });

  // A backend that never answers must degrade the load, not stall it: the caller goes on without
  // progress rather than waiting for a stream it will never get.
  it('whenConnected() settles when the attempt fails', async () => {
    const openStream = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const subscriber = new SseNotificationSubscriber({ openStream, reconnectDelayMs: 100_000 });
    let connected = false;

    subscriber.start();
    void subscriber.whenConnected().then(() => { connected = true; });
    await vi.waitFor(() => expect(connected).toBe(true));

    subscriber.stop();
  });

  it('stop() aborts the in-flight attempt and stops retrying', async () => {
    let sawSignal: AbortSignal | undefined;
    const openStream = vi.fn().mockImplementation((signal: AbortSignal) => {
      sawSignal = signal;
      return new Promise<Response>(() => {}); // never resolves — stop() must abort it directly
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
