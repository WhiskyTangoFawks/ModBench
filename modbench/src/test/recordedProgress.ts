import { WrittenFiles } from '../instanceLoader/writtenFiles';

export const progressSteps: string[] = [];

export const instanceThatReads = {
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
  quiet: <T>(work: (written: WrittenFiles) => Promise<T>): Promise<T> => work(new WrittenFiles()),
};

export async function recordedWithProgress(
  options: { location: { viewId: string } }, task: () => Promise<unknown>,
): Promise<unknown> {
  progressSteps.push(`progress opens on ${options.location.viewId}`);
  try {
    return await task();
  } finally {
    progressSteps.push('progress closes');
  }
}
