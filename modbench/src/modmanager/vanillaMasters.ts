// Vanilla/DLC master set for StatusChecker's missing-master check, read from the
// game's resolved Data folder (the single GameDirectory resolved once at the
// composition root; see gameDirectory.ts). Tolerates an unresolved/unreachable
// Data folder, degrading to an empty set rather than failing the whole tree load.

import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';

const PLUGIN_EXTENSIONS = new Set(['.esp', '.esm', '.esl']);

export async function readVanillaMasters(
  dataFolder: string | undefined,
  log?: (msg: string) => void,
): Promise<Set<string>> {
  if (!dataFolder) return new Set();
  try {
    const dataFiles = await readdir(dataFolder);
    return new Set(
      dataFiles.filter((f) => PLUGIN_EXTENSIONS.has(extname(f).toLowerCase())).map((f) => f.toLowerCase()),
    );
  } catch (e) {
    log?.(`[vanillaMasters] could not resolve vanilla masters: ${e instanceof Error ? e.message : String(e)}`);
    return new Set();
  }
}
