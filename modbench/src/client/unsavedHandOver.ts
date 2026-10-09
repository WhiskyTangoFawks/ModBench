import { errorMessage } from '../ports/errorMessage';
import type { BackendStatus, UnsavedDocument } from './MEditClient';

/** What an adapter gives the hand-over: its process, its stream's reopen, and one PUT of the documents. */
export interface UnsavedDocumentsWire {
  status(): BackendStatus;
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  onReconnected(listener: () => void): () => void;
  put(documents: readonly UnsavedDocument[]): Promise<void>;
}

/** Puts each hand-over at once and in order while mEdit runs, and the newest again whenever the
 *  process behind the wire may hold none. */
export function createUnsavedHandOver(
  wire: UnsavedDocumentsWire, log: (line: string) => void,
): (documents: readonly UnsavedDocument[]) => void {
  let newest: readonly UnsavedDocument[] = [];
  let sending = Promise.resolve();
  const put = (documents: readonly UnsavedDocument[]): void => {
    sending = sending.then(() => wire.put(documents)).catch((e: unknown) => {
      log(`Could not hand mEdit the unsaved plugin source — ${errorMessage(e)}`);
    });
  };
  wire.onStatusChanged((status) => { if (status === 'running') put(newest); });
  wire.onReconnected(() => { put(newest); });
  return (documents) => {
    newest = documents;
    if (wire.status() === 'running') put(documents);
  };
}
