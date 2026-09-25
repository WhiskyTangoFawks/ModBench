import { describe, it, expect, afterEach } from 'vitest';
import { trackSyncRuns } from '../syncFailureReport';

const unhandled: unknown[] = [];
const noteUnhandled = (reason: unknown): void => { unhandled.push(reason); };

afterEach(() => {
  process.off('unhandledRejection', noteUnhandled);
  unhandled.length = 0;
});

describe('trackSyncRuns', () => {
  // Rival: tracking the run itself with a `finally`, whose own promise rejects with nobody to catch
  // it, and whose `settled` rejects with the run.
  it('settles a run that rejects, with no unhandled rejection', async () => {
    process.on('unhandledRejection', noteUnhandled);
    const runs = trackSyncRuns();

    runs.begin(Promise.reject(new Error('the sync threw')));
    await runs.settled();
    // Node reports an unhandled rejection once the microtasks drain, before the next macrotask.
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).toEqual([]);
  });
});
