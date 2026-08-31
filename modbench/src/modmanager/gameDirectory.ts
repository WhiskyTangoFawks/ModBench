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

/** The Proton prefix root (`.../compatdata/<appid>/pfx`), or null if it can't be determined —
 *  e.g. `detectWinePrefix` from `medit/GamePathDetector.ts`. Injected (not called directly) so
 *  this stays pure/no-vscode-import like the rest of this file, matching `DetectPaths`. */
export type DetectWinePrefix = () => Promise<string | null>;

/** MO2 running under Proton/Wine stores gamePath as a Wine drive-mapped, backslash path (e.g.
 *  `Z:\home\user\...` or `C:\Program Files\...`). `Z:` is Wine's fixed mapping of the filesystem
 *  root; `C:` is Wine's fixed mapping of the prefix's own `drive_c` — a real, distinct
 *  location, not the same drive under a different name. Any other drive letter is a user-defined
 *  Wine mapping (`dosdevices/<letter>`) that can point anywhere on the host; there's no reliable
 *  rule to translate it, so it's surfaced as an error rather than guessed at, same as an
 *  undeterminable prefix. On Windows the native path is left untouched. Takes `platform`
 *  explicitly (rather than reading `process.platform` itself) so tests can exercise every branch
 *  directly instead of stubbing global process state. */
export async function normalizeGamePath(
  p: string,
  platform: NodeJS.Platform,
  detectWinePrefix: DetectWinePrefix,
): Promise<string> {
  if (platform === 'win32') return p;

  const match = /^([A-Za-z]):(.*)$/s.exec(p);
  if (!match) return p.replaceAll('\\', '/');

  const [, drive, rest] = match;
  const posixRest = rest.replaceAll('\\', '/');
  if (drive.toUpperCase() === 'Z') return posixRest;

  if (drive.toUpperCase() !== 'C') {
    throw new Error(`Cannot translate Wine drive letter '${drive}:' in '${p}': only Z: and C: are translated`);
  }

  const prefix = await detectWinePrefix();
  if (!prefix) {
    throw new Error(`Cannot translate Wine path '${p}': the Proton prefix could not be determined`);
  }
  return join(prefix, 'drive_c', posixRest);
}

async function hasDataFolder(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, 'Data'))).isDirectory();
  } catch {
    return false;
  }
}

/** Resolution order, first hit wins:
 *  1. explicit `modbench.mods.gameDirectory` (errors if it has no Data/)
 *  2. MO2's ModOrganizer.ini gamePath (normalized from a Wine/Windows path)
 *  3. GamePathDetector autodetect
 *  Returns null when nothing resolves — the caller then prompts. A `normalizeGamePath` translation
 *  failure (a C: path whose Proton prefix can't be determined, or an unsupported drive
 *  letter) propagates as a rejection rather than falling through to autodetect — same treatment as
 *  the explicit-setting misconfiguration above, because guessing a different game directory
 *  entirely would hide the real problem instead of surfacing it. */
export async function resolveGameDirectory(
  instanceRoot: string,
  config: ConfigLike,
  detectPaths: DetectPaths,
  detectWinePrefix: DetectWinePrefix,
): Promise<GameDirectory | null> {
  const explicit = (config.get('mods.gameDirectory') ?? '').trim();
  if (explicit) {
    if (!(await hasDataFolder(explicit))) {
      throw new Error(`modbench.mods.gameDirectory has no Data/ subfolder: ${explicit}`);
    }
    return { root: explicit, dataFolder: join(explicit, 'Data') };
  }

  const fromIni = await readIniGamePath(instanceRoot, detectWinePrefix);
  if (fromIni && (await hasDataFolder(fromIni))) {
    return { root: fromIni, dataFolder: join(fromIni, 'Data') };
  }

  const detected = await detectPaths();
  if (detected) {
    return { root: dirname(detected.dataFolder), dataFolder: detected.dataFolder };
  }

  return null;
}

/** MO2's gamePath (Wine-normalized), or null if the ini is absent/unreadable/missing the key.
 *  Only the ini read/parse is tolerated as "not found" — a `normalizeGamePath` translation failure
 *  is a distinct, genuine error and must propagate, not be folded into the same null here. */
async function readIniGamePath(instanceRoot: string, detectWinePrefix: DetectWinePrefix): Promise<string | null> {
  let raw: string;
  try {
    raw = readGamePath(await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8'));
  } catch {
    return null;
  }
  return normalizeGamePath(raw, process.platform, detectWinePrefix);
}
