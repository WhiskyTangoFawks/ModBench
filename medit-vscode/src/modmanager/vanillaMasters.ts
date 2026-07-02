// Vanilla/DLC master set for StatusChecker's missing-master check, derived
// from MO2's own gamePath (ModOrganizer.ini) — not a mEdit-owned
// GameDirectory config (deferred; see Modbench-3 plan). Tolerates an
// unreachable/misconfigured game path, degrading to an empty set rather than
// failing the whole tree load.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readGamePath } from './mo2/modOrganizerIni';

export async function readVanillaMasters(
  instanceRoot: string,
  log?: (msg: string) => void,
): Promise<Set<string>> {
  try {
    const iniText = await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8');
    const gamePath = readGamePath(iniText);
    const dataFiles = await readdir(join(gamePath, 'Data'));
    return new Set(dataFiles.filter((f) => f.toLowerCase().endsWith('.esm')).map((f) => f.toLowerCase()));
  } catch (e) {
    log?.(`[vanillaMasters] could not resolve vanilla masters: ${e instanceof Error ? e.message : String(e)}`);
    return new Set();
  }
}
