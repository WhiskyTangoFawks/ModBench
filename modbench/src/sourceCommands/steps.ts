import type { ManifestStep } from '../client';
import type { Tasks } from '../ports/tasks';

/** Runs each step in order, its task in the folder the manifest builds, and answers why the first step that failed did,
 *  or nothing when every step exited with code 0. */
export async function whyStepsFailed(tasks: Pick<Tasks, 'run'>, steps: readonly ManifestStep[], folder: string): Promise<string | undefined> {
  for (const { task, args } of steps) {
    const ended = await tasks.run(task, args, folder);
    if (ended === 0) continue;
    return typeof ended === 'number' ? `step '${task}' exited with code ${ended}` : `step '${task}' did not run: ${ended}`;
  }
  return undefined;
}
