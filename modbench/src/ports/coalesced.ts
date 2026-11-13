/** Runs `run` once after the calls of the current turn. Calls made while a run is in flight
 *  bring one more run after it, never an overlapping one. */
export function coalesced(run: () => unknown): () => void {
  let scheduled = false;
  let running = false;
  let calls = 0;
  const drain = async () => {
    running = true;
    try {
      for (let seen = -1; seen !== calls;) {
        seen = calls;
        await run();
      }
    } finally {
      running = false;
    }
  };
  return () => {
    calls += 1;
    if (running || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void drain();
    });
  };
}
