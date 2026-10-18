/** Runs each job given it after the one before it settles. */
export type OneAtATime = <T>(job: () => Promise<T>) => Promise<T>;

export function oneAtATime(): OneAtATime {
  let last: Promise<unknown> = Promise.resolve();
  return (job) => {
    const next = last.then(job, job);
    last = next.catch(() => undefined);
    return next;
  };
}
