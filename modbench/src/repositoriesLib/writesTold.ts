import { AsyncLocalStorage } from 'node:async_hooks';
import type { WritesTold } from '../ports/writesTold';
import type { WriteSink } from '../ports/writeSink';

let loader: WritesTold | undefined;
let diskCheckSink: WriteSink | undefined;

/** Hands every write of the repositories the loader it tells; the composition root calls it once. */
export const writesToldTo = (to: WritesTold): void => { loader = to; };

/** Hands every write the loader is not told of the sink of the command running it, which reads what the write names, or
 *  checks the disk; the composition root calls it once. */
export const diskCheckedBy = (to: WriteSink): void => { diskCheckSink = to; };

export const nameWrites = (paths: readonly string[]): void => diskCheckSink?.name(paths);

export const leaveWritesUnnamed = (): void => diskCheckSink?.leaveUnnamed();

// The command waits on the read's subscribers before it ends: they may hold the write's lock. A failed read is the
// loader's to tell (common.md, A gesture that writes, story 3).
async function tell(paths: readonly string[]): Promise<void> {
  if (paths.length === 0 || loader === undefined) return;
  const told = await loader.told(paths).catch(() => undefined);
  if (told !== undefined) diskCheckSink?.settling(told.subscribed);
}

interface HeldBack { readonly paths: string[]; open: boolean }

const heldBack = new AsyncLocalStorage<HeldBack>();

/** Runs `locked`, work that holds a lock, and tells its writes' files once it settled, as the answer may wait on work that
 *  takes the lock. A lock taken inside another's work leaves the telling to the outer one. */
export async function toldOnceSettled<T>(locked: () => Promise<T>): Promise<T> {
  if (heldBack.getStore()?.open === true) return locked();
  const scope: HeldBack = { paths: [], open: true };
  let answer: T;
  try {
    answer = await heldBack.run(scope, locked);
  } catch (err) {
    scope.open = false;
    await tell(scope.paths);
    throw err;
  }
  scope.open = false;
  await tell(scope.paths);
  return answer;
}

/** Runs `write`, tells the loader its files, and answers once the loader holds them or its read failed. A write failing
 *  halfway may have written them, so it tells them and rejects with its own failure. */
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
    await tell(paths);
    throw err;
  }
  await tell(paths);
  return written;
}
