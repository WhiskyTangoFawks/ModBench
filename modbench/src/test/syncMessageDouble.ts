import type { SyncMessage } from '../syncFailureReport';

/** A sync trigger's message, as a view reads it; `say` is a run that changed it. */
export interface SyncMessageDouble extends SyncMessage {
  say(message: string | undefined): void;
}

export function syncMessageDouble(initial?: string): SyncMessageDouble {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    message: () => current,
    onMessageChanged: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    say: (message) => {
      current = message;
      for (const listener of [...listeners]) listener();
    },
  };
}
