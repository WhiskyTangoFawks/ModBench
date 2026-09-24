import type { NotificationEvent } from './apiClient';
import { isNotificationKind, type NotificationKind } from './MEditClient';
import { errorMessage } from '../ports/errorMessage';

// Subscribing and dispatching for the one stream kind this file opens (SSE); `whenConnected`'s
// default answer below is settled, which `SseNotificationSubscriber` overrides with its own.
class NotificationListenerRegistry {
  private readonly listeners = new Map<NotificationKind, Set<(event: NotificationEvent) => void>>();

  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void {
    const set = this.listeners.get(kind) ?? new Set();
    set.add(listener);
    this.listeners.set(kind, set);
    return () => { set.delete(listener); };
  }

  whenConnected(): Promise<void> {
    return Promise.resolve();
  }

  protected dispatch(event: NotificationEvent): void {
    // `event.kind` is `string` on the wire type (it reports every kind the schema knows, not just
    // the five this client subscribes on); an event this build doesn't route stays undelivered.
    if (!isNotificationKind(event.kind)) return;
    for (const listener of this.listeners.get(event.kind) ?? []) listener(event);
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
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

// The notification stream's one parse point for an SSE frame's JSON: checks the fields every
// event has and throws rather than handing back an unproven shape. parseFrame's caller treats
// the throw the same as a dropped connection.
function parseNotificationEvent(raw: string): NotificationEvent {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Expected a notification event object, got ${typeof parsed}.`);
  }
  const w = parsed as {
    kind?: unknown; plugin?: unknown; origin?: unknown; keys?: unknown; sequence?: unknown;
    loadOrderStatus?: NotificationEvent['loadOrderStatus'];
    trackProgress?: NotificationEvent['trackProgress'];
    externalChangeMetaChanged?: NotificationEvent['externalChangeMetaChanged'];
    externalChangeOldVersion?: NotificationEvent['externalChangeOldVersion'];
    externalChangeNewVersion?: NotificationEvent['externalChangeNewVersion'];
    externalChangeTrackedFiles?: NotificationEvent['externalChangeTrackedFiles'];
    crashRepairReason?: NotificationEvent['crashRepairReason'];
  };
  if (!isString(w.kind)) throw new Error('Expected a notification event to carry a string kind.');
  if (!isString(w.plugin)) throw new Error('Expected a notification event to carry a string plugin.');
  if (!isString(w.origin)) throw new Error('Expected a notification event to carry a string origin.');
  if (!isStringArray(w.keys)) throw new Error('Expected a notification event to carry a string array of keys.');
  if (typeof w.sequence !== 'number') throw new Error('Expected a notification event to carry a numeric sequence.');
  return {
    kind: w.kind, plugin: w.plugin, origin: w.origin, keys: w.keys, sequence: w.sequence,
    loadOrderStatus: w.loadOrderStatus, trackProgress: w.trackProgress,
    externalChangeMetaChanged: w.externalChangeMetaChanged,
    externalChangeOldVersion: w.externalChangeOldVersion, externalChangeNewVersion: w.externalChangeNewVersion,
    externalChangeTrackedFiles: w.externalChangeTrackedFiles,
    crashRepairReason: w.crashRepairReason,
  };
}

function parseFrame(frame: string): NotificationEvent | undefined {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return undefined;
  return parseNotificationEvent(dataLine.slice('data:'.length).trim());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ADR-0014 invariant 2's stream adapter. `start()`/`stop()` are idempotent and follow the
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
  private openedThisStart = false;
  private readonly reopenListeners = new Set<() => void>();

  constructor(private readonly deps: SseNotificationSubscriberDeps) {
    super();
    this.log = deps.log ?? (() => {});
    this.reconnectDelayMs = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    this.openedThisStart = false;
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

  /** Hears each open after the first since `start()`: a stream that dropped and opened again,
   *  perhaps onto another process listening on the same port. */
  onReconnected(listener: () => void): () => void {
    this.reopenListeners.add(listener);
    return () => { this.reopenListeners.delete(listener); };
  }

  /** Settles once the stream carries events, or once the attempt to open it failed; never
   *  rejects. The backend publishes a request's progress the moment that request lands, so a
   *  caller whose progress rides the stream awaits this first. */
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

  private announceOpen(generation: number): void {
    if (this.generation !== generation) return;
    const reopened = this.openedThisStart;
    this.openedThisStart = true;
    if (reopened) for (const listener of [...this.reopenListeners]) listener();
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
      this.announceOpen(generation);
      for await (const frame of readFrames(response.body)) {
        const event = parseFrame(frame);
        if (event) this.dispatch(event);
      }
      if (!this.isStopped()) this.log('[notifications] stream ended; reconnecting');
    } catch (e) {
      if (this.isStopped()) return;
      this.log(`[notifications] stream dropped: ${errorMessage(e)}`);
    } finally {
      // A failed attempt releases the waiting caller too: no stream is a degraded load, not a
      // stalled one.
      settleConnected();
    }
  }
}
