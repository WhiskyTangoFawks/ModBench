import { AsyncLocalStorage } from 'node:async_hooks';

export interface WritesTold {
  /** Answers once the read model holds the files a write wrote. */
  told(paths: readonly string[]): Promise<void>;
}

const untold = new AsyncLocalStorage<true>();

/** Runs `work` with the writes it makes told to no one: a write the loader's own reading makes cannot wait on a later reading, and a
 *  file the loader never reads has nothing to tell it. */
export const withoutTelling = <T>(work: () => Promise<T>): Promise<T> => untold.run(true, work);

export const isTold = (): boolean => untold.getStore() !== true;
