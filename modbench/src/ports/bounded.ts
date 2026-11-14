export const REQUESTS_AT_ONCE = 4;

/** Runs the asks it is given, no more than `limit` at a time and the rest in the order asked. */
export function bounded(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else running -= 1;
  };
  return async (run) => {
    if (running < limit) running += 1;
    else await new Promise<void>((resolve) => { waiting.push(resolve); });
    try {
      return await run();
    } finally {
      release();
    }
  };
}
