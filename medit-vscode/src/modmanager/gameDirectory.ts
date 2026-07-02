// Resolves the game directory (the folder containing the game executable and
// Data/) that the standalone deployer hardlinks into and that vanilla masters
// are read from. Pure over an injected config + game-path detector — no vscode
// import, unit-testable like the rest of modmanager/.

import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readGamePath } from './mo2/modOrganizerIni';

export interface GameDirectory {
  /** Folder containing the game executable and Data/. */
  root: string;
  dataFolder: string;
}

/** Minimal stand-in for vscode's WorkspaceConfiguration. */
export interface ConfigLike {
  get(section: string): string | undefined;
}

export type DetectPaths = () => Promise<{ dataFolder: string; pluginsTxt: string } | null>;

/** MO2 running under Proton/Wine stores gamePath as a Wine drive-mapped,
 *  backslash path (e.g. `Z:\home\wayne\...`), where the Z: drive maps to the
 *  filesystem root. On Linux/macOS that isn't a usable path, so translate it;
 *  on Windows the native `C:\...` form is left untouched. */
export function normalizeGamePath(p: string): string {
  if (process.platform === 'win32') return p;
  return p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/');
}

async function hasDataFolder(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, 'Data'))).isDirectory();
  } catch {
    return false;
  }
}

/** Resolution order, first hit wins:
 *  1. explicit `mEdit.mods.gameDirectory` (errors if it has no Data/)
 *  2. MO2's ModOrganizer.ini gamePath (normalized from a Wine/Windows path)
 *  3. GamePathDetector autodetect
 *  Returns null when nothing resolves — the caller then prompts. */
export async function resolveGameDirectory(
  instanceRoot: string,
  config: ConfigLike,
  detectPaths: DetectPaths,
): Promise<GameDirectory | null> {
  const explicit = (config.get('mods.gameDirectory') ?? '').trim();
  if (explicit) {
    if (!(await hasDataFolder(explicit))) {
      throw new Error(`mEdit.mods.gameDirectory has no Data/ subfolder: ${explicit}`);
    }
    return { root: explicit, dataFolder: join(explicit, 'Data') };
  }

  const fromIni = await readIniGamePath(instanceRoot);
  if (fromIni && (await hasDataFolder(fromIni))) {
    return { root: fromIni, dataFolder: join(fromIni, 'Data') };
  }

  const detected = await detectPaths();
  if (detected) {
    return { root: dirname(detected.dataFolder), dataFolder: detected.dataFolder };
  }

  return null;
}

/** MO2's gamePath (Wine-normalized), or null if the ini is absent/unreadable/
 *  missing the key. */
async function readIniGamePath(instanceRoot: string): Promise<string | null> {
  try {
    return normalizeGamePath(readGamePath(await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8')));
  } catch {
    return null;
  }
}
