/** Runs `run` once after the calls of the current turn, however many there were. */
export function coalesced(run: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      run();
    });
  };
}
