import type { Instance } from '../instanceLoader/instance';
import { pausableProgress, type Progress } from './pausableProgress';
import { Refusal } from './refusal';

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

/** Runs the `write` gesture's `command` under the view's progress. One write runs at a time (commands.md, Refuse, do not
 *  repair): a write asked while another is in flight is refused, naming it. */
export async function runWritingGesture<T>(
  write: string, viewId: string, instance: Pick<Instance, 'refresh'>, command: (progress: Progress) => Promise<T>,
): Promise<T> {
  if (inFlight !== undefined) throw new Refusal(`${write} did not start: ${inFlight} is still writing.`);
  inFlight = write;
  try {
    return await runUnderProgress(viewId, instance, command);
  } finally {
    inFlight = undefined;
  }
}
