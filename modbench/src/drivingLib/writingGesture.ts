import type { Instance } from '../instanceLoader/instance';
import { pausableProgress, type Progress } from './pausableProgress';
import { Refusal } from './refusal';
import type { Reporter } from '../ports/reporter';

export type RecordWrite = (command: () => Promise<void>) => Promise<void>;

/** Runs `command` under the view's progress, which a command that waits on a person closes through the `Progress` it is
 *  given. The refresh that shows the disk is work, so the progress is shown for it. */
export async function runUnderProgress<T>(
  viewId: string, instance: Pick<Instance, 'refresh'>, command: (progress: Progress) => Promise<T>,
): Promise<T> {
  const progress = pausableProgress(viewId);
  progress.working();
  let wrote = true;
  try {
    const answer = await command(progress);
    wrote = !isRefusal(answer);
    return answer;
  } finally {
    try {
      if (wrote) {
        progress.working();
        await instance.refresh();
      }
    } finally {
      await progress.done();
    }
  }
}

// A refused gesture wrote nothing, so it answers at once: the refresh waits on a read that mEdit work in flight can hold for minutes.
function isRefusal(answer: unknown): boolean {
  if (typeof answer !== 'object' || answer === null) return false;
  const { applied, refused } = answer as { applied?: unknown; refused?: unknown };
  return applied === false || refused === true;
}

let inFlight: string | undefined;

interface RefusalSurface {
  readonly reporter: Reporter;
  /** The title of each gesture's Command ID, which a refusal names the write by. */
  readonly titles: ReadonlyMap<string, string>;
  /** Shows the view what is on disk, so a control the user toggled does not keep a state nothing wrote. */
  readonly refresh: () => Promise<void>;
}

let surface: RefusalSurface | undefined;

export function surfaceRefusedWrites(on: RefusalSurface): { dispose: () => void } {
  surface = on;
  return { dispose: () => { surface = undefined; } };
}

const titleOf = (command: string): string => surface?.titles.get(command) ?? command;

/** A write refused because another is in flight. */
export class RefusedWrite extends Refusal {}

/** Runs `work` as a view call: a refused write is told once in a notification and the Output, and the view is shown
 *  the disk (common.md, Reporting). An agent's call skips this: the reason goes back to it. */
export async function asViewCall<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof RefusedWrite)) throw e;
    surface?.reporter.report('error', e.message);
    await surface?.refresh();
    return undefined;
  }
}

/** Runs the `write` gesture's `work`. One write runs at a time (commands.md, Refuse, do not repair): a write asked
 *  while another is in flight is refused, naming it. */
export async function holdingTheWrite<T>(write: string, work: () => Promise<T>): Promise<T> {
  if (inFlight !== undefined) throw new RefusedWrite(`${titleOf(write)} did not start: ${titleOf(inFlight)} is still writing.`);
  inFlight = write;
  try {
    return await work();
  } finally {
    inFlight = undefined;
  }
}

/** Runs the `write` gesture's `command` under the view's progress, holding the write. */
export const runWritingGesture = <T>(
  write: string, viewId: string, instance: Pick<Instance, 'refresh'>, command: (progress: Progress) => Promise<T>,
): Promise<T> => holdingTheWrite(write, () => runUnderProgress(viewId, instance, command));
