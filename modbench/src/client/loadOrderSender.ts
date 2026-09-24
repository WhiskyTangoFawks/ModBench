import type { LoadOrderOutcome, LoadOrderPluginInput, LoadOrderProgress, MEditClient } from './MEditClient';

/** One generation of ADR-0013's hand-off, whole: every physical plugin copy plus the three facts
 *  the PUT is keyed on. Built from one Instance value, so a snapshot never mixes generations. */
export interface LoadOrderSnapshot {
  readonly plugins: LoadOrderPluginInput[];
  readonly gameDirectory: string;
  readonly instanceRoot: string;
  readonly gameRelease: string;
}

/** The port members the sender itself calls — narrowed off `MEditClient` (ADR-0014 invariant 2). */
export type LoadOrderSendClient = Pick<MEditClient, 'putLoadOrder' | 'status' | 'onStatusChanged'>;

export interface LoadOrderSendOptions {
  /** Rides this snapshot's own PUT; a snapshot superseded before it is sent never ticks. */
  onProgress?: (progress: LoadOrderProgress) => void;
}

/** ADR-0013: the one implementation of the Instance-to-mEdit arrow. The sequencing — connect
 *  before the first PUT, one PUT at a time, the newest snapshot the one that lands — is here. */
export interface LoadOrderSender {
  /** Hand mEdit this snapshot. Resolves with this snapshot's own outcome: `abandoned` when a
   *  newer snapshot superseded it before it was sent, or when it was abandoned outright. */
  send(snapshot: LoadOrderSnapshot, options?: LoadOrderSendOptions): Promise<LoadOrderOutcome>;
  /** Whether this snapshot equals the last one sent to the backend attached now. Forgotten when
   *  that send fails, on abandon, and when the backend leaves `attached`: the next one holds none. */
  alreadySent(snapshot: LoadOrderSnapshot): boolean;
  /** The abort scope the send in flight runs under. A launch arms it before its own earlier
   *  phase; re-arming never aborts the scope it replaces, which the backend answers 409. */
  arm(): { signal: AbortSignal; abandoned: () => boolean };
  /** Abort the send in flight and drop whatever was waiting on the connect. Future sends are
   *  untouched: a relaunch still finds this object able to serve them. */
  abandon(): void;
  dispose(): void;
}

const ABANDONED: LoadOrderOutcome = { outcome: 'abandoned' };

interface Waiting {
  snapshot: LoadOrderSnapshot;
  options: LoadOrderSendOptions;
  settle: (outcome: LoadOrderOutcome) => void;
}

// Swallowing the throw here is what keeps one bad send from wedging every send after it; the
// caller still hears the failure as this snapshot's own outcome (ADR-0019).
function putWhole(
  client: LoadOrderSendClient, { snapshot, options }: Waiting, signal: AbortSignal,
): Promise<LoadOrderOutcome> {
  const { plugins, gameDirectory, instanceRoot, gameRelease } = snapshot;
  return client.putLoadOrder(plugins, gameDirectory, instanceRoot, gameRelease, {
    onProgress: options.onProgress, signal,
  }).catch((e: unknown): LoadOrderOutcome => ({
    outcome: 'failed',
    message: `mEdit: Failed to send the load order — ${e instanceof Error ? e.message : String(e)}`,
  }));
}

export function createLoadOrderSender(client: LoadOrderSendClient): LoadOrderSender {
  let armed: AbortController | undefined;
  // At most one: an arrival replaces whatever had not been sent yet, which is what makes the
  // last snapshot the one that lands instead of a queue of stale ones each paying an index.
  let waiting: Waiting | undefined;
  let sending = false;
  let disposed = false;
  let lastSent: LoadOrderSnapshot | undefined;

  const forget = (snapshot: LoadOrderSnapshot): void => {
    if (lastSent === snapshot) lastSent = undefined;
  };

  const arm = (): { signal: AbortSignal; abandoned: () => boolean } => {
    const controller = new AbortController();
    armed = controller;
    return { signal: controller.signal, abandoned: () => controller.signal.aborted };
  };

  const dropWaiting = (): void => {
    const dropped = waiting;
    waiting = undefined;
    dropped?.settle(ABANDONED);
  };

  // The backend publishes a PUT's progress the moment that PUT lands, so a snapshot waits for
  // the connect rather than being sent into a backend that is not there yet.
  const pump = (): void => {
    if (disposed || sending || !waiting || client.status !== 'attached') return;
    const next = waiting;
    waiting = undefined;
    sending = true;
    void putWhole(client, next, arm().signal).then((outcome) => {
      if (outcome.outcome === 'failed') forget(next.snapshot);
      next.settle(outcome);
    }).finally(() => {
      sending = false;
      pump();
    });
  };

  const unsubscribe = client.onStatusChanged((status) => {
    if (status !== 'attached') lastSent = undefined;
    pump();
  });

  return {
    send(snapshot, options = {}) {
      if (disposed) return Promise.resolve(ABANDONED);
      dropWaiting();
      lastSent = snapshot;
      return new Promise<LoadOrderOutcome>((resolve) => {
        waiting = { snapshot, options, settle: resolve };
        pump();
      });
    },
    // Both built by one function from plain data, so their serializations order keys alike.
    alreadySent: (snapshot) => lastSent !== undefined && JSON.stringify(lastSent) === JSON.stringify(snapshot),
    arm,
    abandon() {
      armed?.abort();
      armed = undefined;
      lastSent = undefined;
      dropWaiting();
    },
    dispose() {
      disposed = true;
      unsubscribe();
      dropWaiting();
    },
  };
}
