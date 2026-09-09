import type { NotificationEvent } from './apiClient';
import type { NotificationKind } from './MEditClient';

/** ADR-0046 invariant 12: the adapter's own subscribe surface, transport hidden behind it. */
export interface NotificationSubscriber {
  /** Registers `listener` for one kind; returns the unsubscribe function. */
  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void;
  /** Settles once the transport carries events, or once the attempt to open it failed; never
   *  rejects. The backend publishes a request's progress the moment that request lands, so a
   *  caller whose progress rides the stream awaits this first. */
  whenConnected(): Promise<void>;
}

// Subscribing and dispatching, shared by every kind of stream this adapter could open.
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
