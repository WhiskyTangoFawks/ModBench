import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { InstallationFileReader, InstanceAdapter } from '../instanceAdapter';
import { adapterForInstance } from '../openInstance';
import type { FileProblems } from '../../ports/fileProblems';
import { adapterOver, type AdapterAnswers } from '../../test/mo2/adapterOver';
import { fakeInstallationFileReader } from '../../test/fakeInstallationFileReader';
import { fileProblemsFake } from '../../test/fileProblemsFake';
import { fixedGameFolderSetting } from '../../test/gameFolderSetting';
import { watcherExcluding } from '../../test/watcherExclusion';
import { hostWithoutGit } from '../../test/hostGitDouble';
import { FOMOD_ENGINE } from '../../test/fomodEngine';
import { DEPLOYED_PATH } from '../../test/deployedPath';

const SETTINGS = '[General]\r\ngameName=Fallout 4\r\nselected_profile=@ByteArray(Default)\r\n';

export interface HeldInstance {
  readonly root: string;
  readonly adapter: InstanceAdapter;
  /** The text of the file at `path` below the instance root. */
  readonly text: (path: string) => Promise<string>;
}

/** An MO2 instance of one profile, Default, listing one mod, and holding `files` by their paths below its root, for the length of one test.
 *  A mod order that lists nothing is read again after a wait, as one caught mid-write. */
export function mo2InstanceHolding(files: Readonly<Record<string, string>> = {}, answers: AdapterAnswers = {}): HeldInstance {
  const root = mkdtempSync(join(tmpdir(), 'modbench-codec-'));
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'mods'));
  for (const [path, text] of Object.entries({ 'ModOrganizer.ini': SETTINGS, 'profiles/Default/modlist.txt': '+Base\r\n', 'profiles/Default/plugins.txt': '', ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, adapter: adapterOver(root, answers), text: (path) => readFile(join(root, path), 'utf8') };
}

type FomodEngine = Parameters<typeof adapterForInstance>[0]['fomodEngine'];

/** The adapter as the composition root builds it over `root`, its game folder setting naming `root`'s game folder,
 *  so it never asks Steam, and with `parts` in place of the test's defaults. */
export const composedOver = (
  root: string, parts: { readonly installationFileReader?: InstallationFileReader; readonly fileProblems?: FileProblems; readonly fomodEngine?: FomodEngine } = {},
): InstanceAdapter => adapterForInstance({
  instanceRoot: root, installationFileReader: fakeInstallationFileReader([]), fileProblems: fileProblemsFake(), fomodEngine: FOMOD_ENGINE, deployedPath: DEPLOYED_PATH,
  gameFolderSetting: fixedGameFolderSetting(join(root, 'game')), watcherExclude: watcherExcluding(), hostGit: hostWithoutGit, scriptEnvironmentFileSetting: () => undefined,
  ...parts,
});
