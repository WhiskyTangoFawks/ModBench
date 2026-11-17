import { AsyncLocalStorage } from 'node:async_hooks';
import type { WritesTold } from '../ports/writesTold';
import type { WriteSink } from '../ports/writeSink';

let loader: WritesTold | undefined;
let diskCheckSink: WriteSink | undefined;

/** Hands every write of the repositories the loader it tells; the composition root calls it once. */
export const writesToldTo = (to: WritesTold): void => { loader = to; };

/** Hands every write that cannot name its files the sink of the command running it, so that command checks the disk; the
 *  composition root calls it once. */
export const diskCheckedBy = (to: WriteSink): void => { diskCheckSink = to; };

export const leaveWritesUnnamed = (): void => diskCheckSink?.leaveUnnamed();

const tell = (paths: readonly string[]): Promise<void> =>
  paths.length === 0 || loader === undefined ? Promise.resolve() : loader.told(paths);

interface HeldBack { readonly paths: string[]; open: boolean }

const heldBack = new AsyncLocalStorage<HeldBack>();

/** Runs `locked`, work that holds a lock, and tells its writes' files once it has settled, by `tellAll`: the answer may wait
 *  on work that takes the same lock. A scope inside another leaves the telling to the outer. */
export async function toldOnceSettled<T>(locked: () => Promise<T>, tellAll: (paths: readonly string[]) => Promise<void> = tell): Promise<T> {
  if (heldBack.getStore()?.open === true) return locked();
  const scope: HeldBack = { paths: [], open: true };
  let answer: T;
  try {
    answer = await heldBack.run(scope, locked);
  } catch (err) {
    scope.open = false;
    await tellAll(scope.paths).catch(() => undefined);
    throw err;
  }
  scope.open = false;
  await tellAll(scope.paths);
  return answer;
}

/** Runs `write`, then tells the loader the files it wrote and answers once it holds them. A write that fails halfway may have
 *  written them too, so it tells them and rejects with its own failure. */
export async function toldAfter<T>(paths: readonly string[], write: () => Promise<T>): Promise<T> {
  const scope = heldBack.getStore();
  if (scope?.open === true) {
    try {
      return await write();
    } finally {
      scope.paths.push(...paths);
    }
  }
  let written: T;
  try {
    written = await write();
  } catch (err) {
    await tell(paths).catch(() => undefined);
    throw err;
  }
  await tell(paths);
  return written;
}
