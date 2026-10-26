import type { RestoreOutcome } from '../client/MEditClient';

type RestoredMod = RestoreOutcome['landed'][number];

export const restoredMod = (given: Pick<RestoredMod, 'mod'> & Partial<RestoredMod>): RestoredMod =>
  ({ written: [], namedByNoLine: [], metadata: {}, steps: [], uncommitted: false, ...given });
