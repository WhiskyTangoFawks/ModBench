export class Cancelled extends Error {
  constructor() { super('The request was cancelled.'); }
}

export function untilCaughtUp(problemsCaughtUp: () => Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Cancelled()); return; }
    const cancel = () => { reject(new Cancelled()); };
    signal.addEventListener('abort', cancel, { once: true });
    problemsCaughtUp().then(resolve, reject).finally(() => { signal.removeEventListener('abort', cancel); });
  });
}
