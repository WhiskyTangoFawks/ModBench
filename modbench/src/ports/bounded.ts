export const REQUESTS_AT_ONCE = 4;

export type InTurn = <T>(run: () => Promise<T>, urgent?: boolean) => Promise<T>;

export function bounded(limit: number): InTurn {
  let running = 0;
  const urgentWaiting: (() => void)[] = [];
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = urgentWaiting.shift() ?? waiting.shift();
    if (next) next(); else running -= 1;
  };
  return async (run, urgent = false) => {
    if (running < limit) running += 1;
    else await new Promise<void>((resolve) => { (urgent ? urgentWaiting : waiting).push(resolve); });
    try {
      return await run();
    } finally {
      release();
    }
  };
}
