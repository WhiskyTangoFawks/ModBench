// Vanilla/DLC master set for StatusChecker's missing-master check, derived
// from MO2's own gamePath (ModOrganizer.ini). The gamePath is Wine-normalized
// (Modbench-4) so it resolves on Linux, where MO2 stores it as a Z:\ path.
// Tolerates an unreachable/misconfigured game path, degrading to an empty set
// rather than failing the whole tree load.
//
// Follow-up (Modbench-4): once ModListProvider carries a resolved GameDirectory,
// take that here instead of re-reading/normalizing the ini gamePath.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readGamePath } from './mo2/modOrganizerIni';
import { normalizeGamePath } from './gameDirectory';

export async function readVanillaMasters(
  instanceRoot: string,
  log?: (msg: string) => void,
): Promise<Set<string>> {
  try {
    const iniText = await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8');
    const gamePath = normalizeGamePath(readGamePath(iniText));
    const dataFiles = await readdir(join(gamePath, 'Data'));
    return new Set(dataFiles.filter((f) => f.toLowerCase().endsWith('.esm')).map((f) => f.toLowerCase()));
  } catch (e) {
    log?.(`[vanillaMasters] could not resolve vanilla masters: ${e instanceof Error ? e.message : String(e)}`);
    return new Set();
  }
}
