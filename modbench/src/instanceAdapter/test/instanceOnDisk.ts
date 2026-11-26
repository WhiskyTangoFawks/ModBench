import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { InstanceAdapter, WatcherExclude } from '../instanceAdapter';
import { adapterForInstance } from '../openInstance';
import { adapterOver, type AdapterAnswers } from '../../test/mo2/adapterOver';
import { fixedGameFolderSetting } from '../../test/gameFolderSetting';
import { watcherExcluding } from '../../test/watcherExclusion';
import { hostWithoutGit } from '../../test/hostGitDouble';
import { fakeInstallationFileReader } from '../../test/fakeInstallationFileReader';
import { fileProblemsFake } from '../../test/fileProblemsFake';
import { FOMOD_ENGINE } from '../../test/fomodEngine';
import { DEPLOYED_PATH } from '../../test/deployedPath';

/** MO2's settings naming `gameName`, the Default profile selected, and `general` lines added to [General]. */
export const settingsNaming = (gameName = 'Fallout 4', ...general: string[]): string =>
  ['[General]', `gameName=${gameName}`, 'selected_profile=@ByteArray(Default)', ...general, ''].join('\n');

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

type Options = Parameters<typeof adapterForInstance>[0];

/** What a test fixes of the adapter the extension builds. Without `gameFolderSettingValue`, Steam is asked where the game is. */
export type BuiltParts = Partial<Pick<Options, 'installationFileReader' | 'fileProblems' | 'fomodEngine'>> & {
  readonly gameFolderSettingValue?: string;
  readonly watcherExclude?: WatcherExclude;
};

/** The adapter as the extension builds it over `root`, asking this machine where Steam and the user's folders are and whether MO2 runs. */
export const adapterAsBuilt = (root: string, { gameFolderSettingValue, watcherExclude = watcherExcluding(), ...parts }: BuiltParts = {}): InstanceAdapter => adapterForInstance({
  instanceRoot: root, gameFolderSetting: fixedGameFolderSetting(gameFolderSettingValue), watcherExclude, hostGit: hostWithoutGit,
  installationFileReader: fakeInstallationFileReader([]), fileProblems: fileProblemsFake(), fomodEngine: FOMOD_ENGINE, deployedPath: DEPLOYED_PATH,
  scriptEnvironmentFileSetting: () => undefined, ...parts,
});

/** A meta.ini that records the file a mod was installed from, as MO2 writes the path: a QSettings string, its backslashes escaped. */
export const installationFileMeta = (path: string): string => `[General]\r\ninstallationFile=${path.replaceAll('\\', '\\\\')}\r\n`;
