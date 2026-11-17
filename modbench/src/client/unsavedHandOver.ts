import type { LoadOrderWire } from './loadOrderSender';
import type { UnsavedDocumentChange, WriteRefused } from './MEditClient';

/** What an adapter gives the hand-over: its process, its stream's reopen, and the hand-over of one document, as an open
 *  when mEdit may hold none of it. The hand-over never rejects. */
export type UnsavedDocumentsWire = Pick<LoadOrderWire, 'status' | 'onStatusChanged' | 'onReconnected'> & {
  put(change: UnsavedDocumentChange, opened: boolean): Promise<WriteRefused | undefined>;
};

export interface UnsavedHandOver {
  hand: (change: UnsavedDocumentChange) => void;
  /** Told as each hand-over answers: undefined when mEdit holds every document as handed, else why not the first. */
  onSettled: (listener: (failure: WriteRefused | undefined) => void) => () => void;
  /** Resolves once every hand-over so far has answered. */
  sent: () => Promise<void>;
  pending: () => boolean;
  /** Told wherever `pending` may have changed. */
  onPendingChanged: (listener: () => void) => () => void;
}

interface Document {
  latest: UnsavedDocumentChange;
  /** mEdit has not taken `latest`. */
  waiting: boolean;
  /** mEdit has taken an open of it since it last may have lost it. */
  taken: boolean;
  /** mEdit has not taken `latest` since the last hand-over. */
  failed: boolean;
}

/** Hands the newest change of each document, in the order they were first handed, while mEdit runs. A change mEdit did
 *  not take waits and is handed again with the next hand-over and whenever the process may hold none. */
export function createUnsavedHandOver(wire: UnsavedDocumentsWire): UnsavedHandOver {
  const listeners = new Set<(failure: WriteRefused | undefined) => void>();
  const documents = new Map<string, Document>();
  const failures = new Map<string, WriteRefused>();
  const pendingListeners = new Set<() => void>();
  const pendingChanged = () => { for (const listener of pendingListeners) listener(); };
  let sending = Promise.resolve();
  let active = false;

  const send = async (path: string): Promise<void> => {
    const document = documents.get(path);
    if (document === undefined) return;
    const { latest } = document;
    const failure = await wire.put(latest, !document.taken);
    document.failed = failure !== undefined;
    if (failure === undefined) {
      failures.delete(path);
      if (document.latest === latest) document.waiting = false;
      document.taken = true;
      if ('closed' in latest && !document.waiting) documents.delete(path);
    } else {
      failures.set(path, failure);
    }
    for (const listener of listeners) listener(failures.values().next().value);
  };

  const sendAll = async (): Promise<void> => {
    for (let next = firstToSend(); next !== undefined; next = firstToSend()) await send(next);
  };

  const firstToSend = (): string | undefined => [...documents].find(([, { waiting, failed }]) => waiting && !failed)?.[0];

  const kick = (): void => {
    if (active || wire.status() !== 'running') return;
    active = true;
    pendingChanged();
    sending = sendAll().finally(() => {
      active = false;
      pendingChanged();
    });
  };

  const handOpen = () => {
    for (const document of documents.values()) {
      document.waiting = true;
      document.taken = false;
      document.failed = false;
    }
    kick();
  };
  wire.onStatusChanged((status) => { if (status === 'running') handOpen(); });
  wire.onReconnected(handOpen);
  return {
    hand: (change) => {
      const held = documents.get(change.path);
      if (held === undefined) documents.set(change.path, { latest: change, waiting: true, taken: false, failed: false });
      else Object.assign(held, { latest: change, waiting: true });
      for (const document of documents.values()) document.failed = false;
      kick();
    },
    sent: () => sending,
    pending: () => active,
    onPendingChanged: (listener) => {
      pendingListeners.add(listener);
      return () => { pendingListeners.delete(listener); };
    },
    onSettled: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
