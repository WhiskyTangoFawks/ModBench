import type { MEditClient } from '../client';

interface Reads {
  mEdit: Pick<MEditClient, 'recordIndexMayBeLate' | 'onDidChange' | 'onLoadOrderStatus'>;
  /** Resolves once every change mEdit named has its problems in the diagnostics. */
  problemsCaughtUp: () => Promise<void>;
}

function cancellable(wait: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { reject(new Error('The request was cancelled.')); };
    signal.addEventListener('abort', cancel, { once: true });
    wait.then(resolve, reject).finally(() => { signal.removeEventListener('abort', cancel); });
  });
}

function nextHeard(mEdit: Reads['mEdit'], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { change.dispose(); stopStatus(); signal.removeEventListener('abort', cancel); };
    const heard = () => { stop(); resolve(); };
    const cancel = () => { stop(); reject(new Error('The request was cancelled.')); };
    const change = mEdit.onDidChange(heard);
    const stopStatus = mEdit.onLoadOrderStatus(heard);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Waits until the diagnostics show what mEdit has named as changed, and while the record index may not hold what was written. The request's cancellation bounds it. */
export async function untilCaughtUp({ mEdit, problemsCaughtUp }: Reads, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    await cancellable(problemsCaughtUp(), signal);
    if (!mEdit.recordIndexMayBeLate) return;
    await nextHeard(mEdit, signal);
  }
}
