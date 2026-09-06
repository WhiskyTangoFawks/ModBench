import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
  },
}));

import {
  FakeNotificationSubscriber, SseNotificationSubscriber,
  subscribeTreeToNotifications, subscribeRecordPanelsToNotifications,
} from '../NotificationSubscriber';
import { ActiveRecordTracker } from '../ActiveRecordTracker';
import { makeOnRecordEdited } from '../onRecordEdited';
import type { PluginTreeProvider } from '../PluginTreeProvider';
import type { RecordDecorationProvider } from '../RecordDecorationProvider';
import type { NotificationEvent } from '../ApiClient';

function rowsChanged(keys: string[], overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return { kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys, sequence: 1, ...overrides };
}

function pluginChanged(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return { kind: 'plugin-changed', plugin: 'Test.esp', origin: 'ModA', keys: [], sequence: 1, ...overrides };
}

function fakePanel(): { webview: { postMessage: ReturnType<typeof vi.fn> } } {
  return { webview: { postMessage: vi.fn() } };
}

describe('subscribeRecordPanelsToNotifications', () => {
  it('rows-changed naming the panel\'s own FormKey re-reads that one panel', () => {
    const notifications = new FakeNotificationSubscriber();
    const panel = fakePanel();
    const recordPanels = new Set([panel]) as unknown as Set<import('vscode').WebviewPanel>;
    const tracker = new ActiveRecordTracker<import('vscode').WebviewPanel>();
    tracker.setFormKey(panel as unknown as import('vscode').WebviewPanel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(notifications, recordPanels, tracker);

    notifications.emit(rowsChanged(['000001:Test.esp']));

    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'loadRecord', formKey: '000001:Test.esp' });
  });

  it('rows-changed naming a different FormKey re-reads nothing', () => {
    const notifications = new FakeNotificationSubscriber();
    const panel = fakePanel();
    const recordPanels = new Set([panel]) as unknown as Set<import('vscode').WebviewPanel>;
    const tracker = new ActiveRecordTracker<import('vscode').WebviewPanel>();
    tracker.setFormKey(panel as unknown as import('vscode').WebviewPanel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(notifications, recordPanels, tracker);

    notifications.emit(rowsChanged(['000002:Other.esp']));

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('plugin-changed never reaches a record panel — only rows-changed does', () => {
    const notifications = new FakeNotificationSubscriber();
    const panel = fakePanel();
    const recordPanels = new Set([panel]) as unknown as Set<import('vscode').WebviewPanel>;
    const tracker = new ActiveRecordTracker<import('vscode').WebviewPanel>();
    tracker.setFormKey(panel as unknown as import('vscode').WebviewPanel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(notifications, recordPanels, tracker);

    notifications.emit(pluginChanged());

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('unsubscribing stops further re-reads', () => {
    const notifications = new FakeNotificationSubscriber();
    const panel = fakePanel();
    const recordPanels = new Set([panel]) as unknown as Set<import('vscode').WebviewPanel>;
    const tracker = new ActiveRecordTracker<import('vscode').WebviewPanel>();
    tracker.setFormKey(panel as unknown as import('vscode').WebviewPanel, '000001:Test.esp');
    const unsubscribe = subscribeRecordPanelsToNotifications(notifications, recordPanels, tracker);

    unsubscribe();
    notifications.emit(rowsChanged(['000001:Test.esp']));

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });
});

// ADR-0046 invariant 5: makeOnRecordEdited (the write's own callback) is silent; the stream is
// the panel's only re-read trigger.
describe('a write and the stream, together (ADR-0046 invariant 5)', () => {
  it('after a write, the panel re-reads exactly once, on rows-changed', () => {
    const notifications = new FakeNotificationSubscriber();
    const panel = fakePanel();
    const recordPanels = new Set([panel]) as unknown as Set<import('vscode').WebviewPanel>;
    const tracker = new ActiveRecordTracker<import('vscode').WebviewPanel>();
    tracker.setFormKey(panel as unknown as import('vscode').WebviewPanel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(notifications, recordPanels, tracker);

    const treeProvider = { markWorkingTreeState: vi.fn().mockReturnValue(false) } as unknown as PluginTreeProvider;
    const decorationProvider = { refresh: vi.fn() } as unknown as RecordDecorationProvider;
    const onRecordEdited = makeOnRecordEdited(treeProvider, decorationProvider, vi.fn(), vi.fn());

    onRecordEdited('000001:Test.esp', 'Test.esp', 'ModA');
    expect(panel.webview.postMessage).not.toHaveBeenCalled();

    notifications.emit(rowsChanged(['000001:Test.esp']));

    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'loadRecord', formKey: '000001:Test.esp' });
  });
});

describe('subscribeTreeToNotifications', () => {
  it('refreshes on rows-changed', () => {
    const notifications = new FakeNotificationSubscriber();
    const tree = { refresh: vi.fn() };
    subscribeTreeToNotifications(notifications, tree);

    notifications.emit(rowsChanged(['000001:Test.esp']));

    expect(tree.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes on plugin-changed', () => {
    const notifications = new FakeNotificationSubscriber();
    const tree = { refresh: vi.fn() };
    subscribeTreeToNotifications(notifications, tree);

    notifications.emit(pluginChanged());

    expect(tree.refresh).toHaveBeenCalledTimes(1);
  });
});

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
