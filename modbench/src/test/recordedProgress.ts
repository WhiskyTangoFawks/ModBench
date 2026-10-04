export const progressSteps: string[] = [];

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
