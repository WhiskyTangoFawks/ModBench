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
  try {
    return await command(progress);
  } finally {
    progress.working();
    try {
      await instance.refresh();
    } finally {
      await progress.done();
    }
  }
}

let inFlight: string | undefined;

interface RefusalSurface {
  readonly reporter: Reporter;
  /** The title of each gesture's Command ID, which a refusal names the write by. */
  readonly titles: ReadonlyMap<string, string>;
}

let surface: RefusalSurface | undefined;

/** Where a refused write is logged. VS Code shows the refusal as the notification a rejected command gets (common.md, Reporting). */
export function surfaceRefusedWrites(on: RefusalSurface): { dispose: () => void } {
  surface = on;
  return { dispose: () => { surface = undefined; } };
}

const titleOf = (command: string): string => surface?.titles.get(command) ?? command;

/** Runs the `write` gesture's `work`. One write runs at a time (commands.md, Refuse, do not repair): a write asked
 *  while another is in flight is refused, naming it. */
export async function holdingTheWrite<T>(write: string, work: () => Promise<T>): Promise<T> {
  if (inFlight !== undefined) {
    const message = `${titleOf(write)} did not start: ${titleOf(inFlight)} is still writing.`;
    surface?.reporter.shownOnSurface('error', message);
    throw new Refusal(message);
  }
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
