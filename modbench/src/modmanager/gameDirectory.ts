// Pure over an injected config and game-path detector — no vscode import, unit-testable
// like the rest of modmanager/.

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

/** ModOrganizer.ini's text. Defaults to reading the file; a caller already holding the same
 *  generation's text (the Instance, ADR-0047) injects it instead, so the ini is read once. */
export type ReadIniText = () => Promise<string>;

/** The Proton prefix root (`.../compatdata/<appid>/pfx`), or null if undeterminable. Injected
 *  so this file stays free of a vscode import. */
export type DetectWinePrefix = () => Promise<string | null>;

/** Wine fixes `Z:` to the filesystem root and `C:` to the prefix's own `drive_c`; any other
 *  letter is a user-defined `dosdevices` mapping that can point anywhere, so it is surfaced as
 *  an error rather than guessed at. */
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

/** Explicit setting, then MO2's `gamePath`, then autodetect; null when nothing resolves. A
 *  translation failure rejects rather than falling through to autodetect, because resolving a
 *  different game directory entirely would hide the real problem. */
export async function resolveGameDirectory(
  instanceRoot: string,
  config: ConfigLike,
  detectPaths: DetectPaths,
  detectWinePrefix: DetectWinePrefix,
  readIniText: ReadIniText = () => readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8'),
): Promise<GameDirectory | null> {
  const explicit = (config.get('mods.gameDirectory') ?? '').trim();
  if (explicit) {
    if (!(await hasDataFolder(explicit))) {
      throw new Error(`modbench.mods.gameDirectory has no Data/ subfolder: ${explicit}`);
    }
    return { root: explicit, dataFolder: join(explicit, 'Data') };
  }

  const fromIni = await readIniGamePath(readIniText, detectWinePrefix);
  if (fromIni && (await hasDataFolder(fromIni))) {
    return { root: fromIni, dataFolder: join(fromIni, 'Data') };
  }

  const detected = await detectPaths();
  if (detected) {
    return { root: dirname(detected.dataFolder), dataFolder: detected.dataFolder };
  }

  return null;
}

// Only the ini read/parse is tolerated as "not found"; a translation failure must propagate.
async function readIniGamePath(readIniText: ReadIniText, detectWinePrefix: DetectWinePrefix): Promise<string | null> {
  let raw: string;
  try {
    raw = readGamePath(await readIniText());
  } catch {
    return null;
  }
  return normalizeGamePath(raw, process.platform, detectWinePrefix);
}
