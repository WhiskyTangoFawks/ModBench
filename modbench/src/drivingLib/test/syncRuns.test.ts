import { describe, it, expect, afterEach } from 'vitest';
import { trackSyncRuns } from '../syncFailureReport';

const unhandled: unknown[] = [];
const untilUnhandledRejectionsReport = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const noteUnhandled = (reason: unknown): void => { unhandled.push(reason); };

afterEach(() => {
  process.off('unhandledRejection', noteUnhandled);
  unhandled.length = 0;
});

describe('trackSyncRuns', () => {
  it('settles a run that rejects, with no unhandled rejection', async () => {
    process.on('unhandledRejection', noteUnhandled);
    const runs = trackSyncRuns();

    runs.begin(Promise.reject(new Error('the sync threw')));
    await runs.settled();
    await untilUnhandledRejectionsReport();

    expect(unhandled).toEqual([]);
  });
});
