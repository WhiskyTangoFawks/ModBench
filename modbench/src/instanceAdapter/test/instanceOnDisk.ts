import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InstanceAdapter } from '../instanceAdapter';
import { adapterForInstance } from '../openInstance';
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

/** An MO2 instance in a fresh temp folder: settings naming Fallout 4, the Default profile listing the one mod A, and
 *  `files` (relative paths, `/`-separated) over them. A mod order never empty is never read again after a settle. */
export async function instanceOnDisk(files: Readonly<Record<string, string | Buffer>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'modbench-instance-'));
  await mkdir(join(root, 'mods', 'A'), { recursive: true });
  const all = { 'ModOrganizer.ini': settingsNaming(), 'profiles/Default/modlist.txt': '+A\n', 'profiles/Default/plugins.txt': '', ...files };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
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

/** The adapter as the extension builds it over `root`, asking the machine where Steam and the user's folders are. */
export const adapterAsBuilt = (root: string, gameFolderSettingValue?: string): InstanceAdapter => adapterForInstance({
  instanceRoot: root, gameFolderSetting: fixedGameFolderSetting(gameFolderSettingValue), watcherExclude: watcherExcluding(), hostGit: hostWithoutGit,
  installationFileReader: fakeInstallationFileReader([]), fileProblems: fileProblemsFake(), fomodEngine: FOMOD_ENGINE, deployedPath: DEPLOYED_PATH,
  scriptEnvironmentFileSetting: () => undefined,
});
