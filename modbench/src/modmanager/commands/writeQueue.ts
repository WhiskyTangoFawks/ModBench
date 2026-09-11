// The serialization every read-modify-write verb needs: two edits of one file, each splicing the
// text the other had already read, would drop one of them. Infrastructure the verbs share, not
// an abstraction over them.

export interface WriteQueue {
  /** Runs `task` after every task queued on `key` before it, and answers what it answered. */
  <T>(key: string, task: () => Promise<T>): Promise<T>;
  /** The keys whose chain is still in flight — what the pruning below keeps bounded. */
  readonly held: () => readonly string[];
}

/** One queue set per file the verbs write, so two files never serialize against each other. */
export function createWriteQueue(): WriteQueue {
  const chains = new Map<string, Promise<unknown>>();
  const run = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prior = chains.get(key) ?? Promise.resolve();
    const next = prior.then(task, task);
    // The chain tail must never stay rejected, or every later write on this key queues behind a
    // dead link forever — only the caller's own `next` sees the error.
    const settled = next.then(() => undefined, () => undefined);
    chains.set(key, settled);
    // An idle key is forgotten, so a long session holds only what is in flight. A task queued
    // meanwhile has replaced the entry, and that chain keeps its place.
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return next;
  };
  return Object.assign(run, { held: () => [...chains.keys()] });
}
