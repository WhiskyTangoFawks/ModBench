import type { RestoreResult } from '../sourceCommands/restoreFromManifest';

type ModRestored = RestoreResult['landed'][number];

export const restoredMod = (given: Pick<ModRestored, 'mod'> & Partial<ModRestored>): ModRestored =>
  ({ written: [], namedByNoLine: [], ...given });
