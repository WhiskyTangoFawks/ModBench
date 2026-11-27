import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { InstanceAdapter, Machine } from '../instanceAdapter';
import { adapterOver, type AdapterAnswers } from '../../test/mo2/adapterOver';

/** MO2's settings naming `gameName`, the Default profile selected, and `general` lines added to [General]. */
export const settingsNaming = (gameName = 'Fallout 4', ...general: string[]): string =>
  `[General]\ngameName=${gameName}\nselected_profile=@ByteArray(Default)\n${general.map((line) => `${line}\n`).join('')}`;

/** A path as QSettings writes it in a value: each backslash doubled. */
export const qSettingsPath = (path: string): string => `@ByteArray(${path.replaceAll('\\', '\\\\')})`;

// Settings naming Fallout 4, the Default profile listing the one mod A, and `files` (relative paths, `/`-separated) over them.
// A mod order never empty is never read again after a settle.
function instanceWritten(root: string, files: Readonly<Record<string, string | Buffer>>): void {
  mkdirSync(join(root, 'mods', 'A'), { recursive: true });
  for (const [path, content] of Object.entries({ 'ModOrganizer.ini': settingsNaming(), 'profiles/Default/modlist.txt': '+A\n', 'profiles/Default/plugins.txt': '', ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** An MO2 instance in a fresh temp folder that the caller removes. */
export async function instanceOnDisk(files: Readonly<Record<string, string | Buffer>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'modbench-instance-'));
  instanceWritten(root, files);
  return root;
}

export interface HeldInstance {
  readonly root: string;
  readonly adapter: InstanceAdapter;
  /** The text of the file at `path` below the instance root. */
  readonly text: (path: string) => Promise<string>;
}

/** An MO2 instance, as `instanceOnDisk` writes it, for the length of one test, and the adapter over it. */
export function mo2InstanceHolding(files: Readonly<Record<string, string>> = {}, answers: AdapterAnswers = {}): HeldInstance {
  const root = mkdtempSync(join(tmpdir(), 'modbench-instance-'));
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }); });
  instanceWritten(root, files);
  return { root, adapter: adapterOver(root, answers), text: (path) => readFile(join(root, path), 'utf8') };
}

/** A game folder in a fresh temp folder: its Data folder, and `files` (relative to the game folder) in it. */
export async function gameOnDisk(files: Readonly<Record<string, string | Buffer>> = {}): Promise<string> {
  const game = await mkdtemp(join(tmpdir(), 'modbench-game-'));
  await mkdir(join(game, 'Data'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(game, path)), { recursive: true });
    await writeFile(join(game, path), content);
  }
  return game;
}

/** Points the downloads folder of the instance at `root`, whose settings end in their [Settings] section, at a drive letter
 *  Wine has no translation for; the machine on which it resolves to no folder. */
export async function downloadsUnresolvable(root: string): Promise<Partial<Machine>> {
  await appendFile(join(root, 'ModOrganizer.ini'), `download_directory=${qSettingsPath('D:\\downloads')}\r\n`);
  return { platform: 'linux' };
}

/** A meta.ini that records the file a mod was installed from, as MO2 writes the path: a QSettings string, its backslashes escaped. */
export const installationFileMeta = (path: string): string => `[General]\r\ninstallationFile=${path.replaceAll('\\', '\\\\')}\r\n`;
