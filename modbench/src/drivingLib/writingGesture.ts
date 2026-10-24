import type { Instance } from '../instanceLoader/instance';
import { pausableProgress, type Progress } from './pausableProgress';

export type RecordWrite = (command: () => Promise<void>) => Promise<void>;

/** Runs `command` under the view's progress, which a command that waits on a person closes through the `Progress` it is
 *  given. The refresh that shows the disk is work, so the progress is shown for it. */
export async function runWritingGesture<T>(
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
