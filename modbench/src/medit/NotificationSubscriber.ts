import type * as vscode from 'vscode';
import type { NotificationEvent } from './ApiClient';
import type { ActiveRecordTracker } from './ActiveRecordTracker';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from './messages';

/** The wire's five kinds, narrowed from the schema's honest `string` for a typed `subscribe` call
 *  — not a mirror of `NotificationEvent`, which keeps every field as the schema reports it. */
export type NotificationKind =
  | 'rows-changed' | 'plugin-changed' | 'load-order-status' | 'track-progress' | 'external-change-pending';

/** ADR-0046 invariant 12: the extension's one subscribe interface, transport behind an adapter.
 *  `SseNotificationSubscriber` and `FakeNotificationSubscriber` are its two adapters. */
export interface NotificationSubscriber {
  /** Registers `listener` for one kind; returns the unsubscribe function. */
  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void;
  /** Settles once the transport carries events, or once the attempt to open it failed; never
   *  rejects. The backend publishes a request's progress the moment that request lands, so a
   *  caller whose progress rides the stream awaits this first. */
  whenConnected(): Promise<void>;
}

// Shared bookkeeping for both adapters below — subscribing and dispatching is identical, only
// where events come from differs.
class NotificationListenerRegistry implements NotificationSubscriber {
  private readonly listeners = new Map<NotificationKind, Set<(event: NotificationEvent) => void>>();

  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void {
    const set = this.listeners.get(kind) ?? new Set();
    set.add(listener);
    this.listeners.set(kind, set);
    return () => { set.delete(listener); };
  }

  /** An adapter with no transport between `emit` and its listeners already carries events; the
   *  stream adapter below overrides this with its connection's own answer. */
  whenConnected(): Promise<void> {
    return Promise.resolve();
  }

  protected dispatch(event: NotificationEvent): void {
    for (const listener of this.listeners.get(event.kind as NotificationKind) ?? []) listener(event);
  }
}

/** The test double ADR-0046 invariant 12 names as the subscribe interface's second adapter: no
 *  stream, no timers — a unit test drives it with `emit`. */
export class FakeNotificationSubscriber extends NotificationListenerRegistry {
  emit(event: NotificationEvent): void {
    this.dispatch(event);
  }
}

export interface SseNotificationSubscriberDeps {
  /** Opens one connection attempt, fresh per (re)connect. Injected so reconnect is exercised with
   *  a double, never a live backend. */
  openStream: (signal: AbortSignal) => Promise<Response>;
  log?: (msg: string) => void;
  /** How long to wait before retrying after the stream drops or ends. */
  reconnectDelayMs?: number;
}

const DEFAULT_RECONNECT_DELAY_MS = 2000;

// Splits the raw SSE byte stream on the blank line every frame ends with, tolerant of the
// server's leading `: connected` comment (backend SseNotificationPublisher).
async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        yield buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// A comment-only frame (`: connected`) has no `data:` line and parses to `undefined`. Only
// `data:` is read: it already carries `kind`, so the SSE `event:` line is redundant.
function parseFrame(frame: string): NotificationEvent | undefined {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return undefined;
  return JSON.parse(dataLine.slice('data:'.length).trim()) as NotificationEvent;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ADR-0046 invariant 12's stream adapter. `start()`/`stop()` are idempotent and follow the
 *  backend's lifecycle from the composition root; a dropped or ended stream reconnects on its
 *  own, on `reconnectDelayMs`, until `stop()` ends the loop. */
export class SseNotificationSubscriber extends NotificationListenerRegistry {
  private readonly log: (msg: string) => void;
  private readonly reconnectDelayMs: number;
  private abortController: AbortController | undefined;
  private stopped = true;
  // `stopped` cannot end a loop asleep between attempts: a restart clears it again and the
  // sleeper wakes into a second, parallel loop. A loop whose generation is stale exits instead.
  private generation = 0;
  private connected: Promise<void> = Promise.resolve();
  private markConnected: (() => void) | undefined;

  constructor(private readonly deps: SseNotificationSubscriberDeps) {
    super();
    this.log = deps.log ?? (() => {});
    this.reconnectDelayMs = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    this.connected = new Promise((resolve) => { this.markConnected = resolve; });
    void this.runLoop(generation);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.abortController?.abort();
    // Nothing waits on a stream the session has closed.
    this.markConnected?.();
  }

  override whenConnected(): Promise<void> {
    return this.connected;
  }

  // A direct `this.stopped` read narrows across the `await`s below, since TS cannot see stop()
  // reassigning it mid-loop; the method call is opaque to that stale narrowing.
  private isStopped(): boolean {
    return this.stopped;
  }

  private async runLoop(generation: number): Promise<void> {
    while (this.generation === generation) {
      await this.connectOnce(generation);
      if (this.generation !== generation) break;
      await delay(this.reconnectDelayMs);
    }
  }

  private async connectOnce(generation: number): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    // A stale loop must not release the generation that replaced it.
    const settleConnected = () => { if (this.generation === generation) this.markConnected?.(); };
    try {
      const response = await this.deps.openStream(controller.signal);
      if (!response.ok || !response.body) throw new Error(`notification stream responded ${response.status}`);
      settleConnected();
      for await (const frame of readFrames(response.body)) {
        const event = parseFrame(frame);
        if (event) this.dispatch(event);
      }
      if (!this.isStopped()) this.log('[notifications] stream ended; reconnecting');
    } catch (e) {
      if (this.isStopped()) return;
      this.log(`[notifications] stream dropped: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // A failed attempt releases the waiting caller too: no stream is a degraded load, not a
      // stalled one.
      settleConnected();
    }
  }
}

// Any reconcile-free record change is reason enough for a whole refresh() — the tree has no
// per-row identity to check against the event (ADR-0046 invariant 5).
export function subscribeTreeToNotifications(
  subscriber: NotificationSubscriber, tree: { refresh(): void },
): () => void {
  const unsubscribeRows = subscriber.subscribe('rows-changed', () => tree.refresh());
  const unsubscribePlugin = subscriber.subscribe('plugin-changed', () => tree.refresh());
  return () => { unsubscribeRows(); unsubscribePlugin(); };
}

// One FormKey spans its whole override chain, so matching it alone is enough — no plugin/origin
// check. LOAD_RECORD already re-reads unconditionally, even for an already-shown FormKey.
export function subscribeRecordPanelsToNotifications(
  subscriber: NotificationSubscriber,
  recordPanels: Set<vscode.WebviewPanel>,
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>,
): () => void {
  return subscriber.subscribe('rows-changed', (event) => {
    for (const panel of recordPanels) {
      const formKey = activeRecordTracker.formKeyOf(panel);
      if (formKey && event.keys.includes(formKey)) {
        void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey } satisfies ExtensionToWebview);
      }
    }
  });
}
