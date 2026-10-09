import type { ReadFailed } from '../wire/readFailed';
import type { LoadOrderWire } from './loadOrderSender';
import type { UnsavedDocument } from './MEditClient';

/** What an adapter gives the hand-over: its process, its stream's reopen, and one PUT of the documents. */
export type UnsavedDocumentsWire = Pick<LoadOrderWire, 'status' | 'onStatusChanged' | 'onReconnected'> & {
  put(documents: readonly UnsavedDocument[]): Promise<ReadFailed | undefined>;
};

export interface UnsavedHandOver {
  hand: (documents: readonly UnsavedDocument[]) => void;
  /** Each put as it answers: undefined when mEdit took the documents, else how not. */
  onSettled: (listener: (failure: ReadFailed | undefined) => void) => () => void;
  /** Resolves once every put handed so far has answered. */
  sent: () => Promise<void>;
}

/** Puts each hand-over at once and in order while mEdit runs, and the newest again whenever the
 *  process behind the wire may hold none. */
export function createUnsavedHandOver(wire: UnsavedDocumentsWire): UnsavedHandOver {
  const listeners = new Set<(failure: ReadFailed | undefined) => void>();
  const settle = (failure: ReadFailed | undefined) => { for (const listener of listeners) listener(failure); };
  let newest: readonly UnsavedDocument[] = [];
  let sending = Promise.resolve();
  const put = (documents: readonly UnsavedDocument[]): void => {
    sending = sending.then(() => wire.put(documents)).then(settle);
  };
  wire.onStatusChanged((status) => { if (status === 'running') put(newest); });
  wire.onReconnected(() => { put(newest); });
  return {
    hand: (documents) => {
      newest = documents;
      if (wire.status() === 'running') put(documents);
    },
    sent: () => sending,
    onSettled: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
