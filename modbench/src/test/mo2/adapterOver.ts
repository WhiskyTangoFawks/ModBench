import type {
  InstallationFileReader, DownloadedFile, InstanceAdapter, InstanceReading, Machine, ModlistEntry, OriginFiles, PluginEntry, Subscription, WatcherExclude,
} from '../../instanceAdapter/instanceAdapter';
import { fileProblemsFake } from '../fileProblemsFake';
import type { FileProblems } from '../../ports/fileProblems';
import { adapterForInstance } from '../../instanceAdapter/openInstance';
import type { Mo2InstanceOptions } from '../../instanceAdapter/mo2/mo2Instance';
import { mo2Context } from '../../instanceAdapter/mo2/mo2Context';
import type { FomodEngine } from '../../instanceAdapter/fomodInstaller/fomodInstaller';
import type { HostGit } from '../../ports/repository';
import { hostWithoutGit } from '../hostGitDouble';
import type { ReadingSource } from '../../instanceAdapter/instanceReading';
import { readingSource } from '../../instanceAdapter/mo2/mo2Reads';
import type { PluginCommands, pluginCommands } from '../../pluginCommands/plugins';
import { pluginCommandsWith } from '../pluginCommandsWith';
import { fakeInstallationFileReader } from '../fakeInstallationFileReader';
import { fakeMachine } from '../fakeMachine';
import { fixedGameFolderSetting } from '../gameFolderSetting';
import { watcherExcluding } from '../watcherExclusion';
import { FOMOD_ENGINE } from '../fomodEngine';
import { DEPLOYED_PATH } from '../deployedPath';
import { expectKind } from '../expectKind';

/** What a test fixes of the adapter the extension builds. */
export interface AdapterAnswers {
  pythonEnvFile?: string;
  /** What every installation file holds; none when the test fixes no reader. */
  installationFileReader?: InstallationFileReader;
  /** The setting that names the game's folder, or what it holds at each read. */
  gameFolderSettingValue?: string | (() => string | undefined);
  gameFolderSettingChanged?: (listener: () => void) => Subscription;
  /** What the machine answers in place of `fakeMachine`'s. */
  machine?: Partial<Machine>;
  fileProblems?: FileProblems;
  /** VS Code's git; none unless a test fixes one. */
  hostGit?: HostGit<string>;
  watcherExclude?: WatcherExclude;
  fomodEngine?: FomodEngine;
}

const optionsOver = (root: string, answers: AdapterAnswers): Mo2InstanceOptions => ({
  instanceRoot: root,
  installationFileReader: answers.installationFileReader ?? fakeInstallationFileReader([]),
  fileProblems: answers.fileProblems ?? fileProblemsFake(),
  fomodEngine: answers.fomodEngine ?? FOMOD_ENGINE,
  deployedPath: DEPLOYED_PATH,
  gameFolderSetting: fixedGameFolderSetting(answers.gameFolderSettingValue, answers.gameFolderSettingChanged),
  watcherExclude: answers.watcherExclude ?? watcherExcluding(),
  hostGit: answers.hostGit ?? hostWithoutGit,
  machine: fakeMachine(answers.machine),
});

/** The parts of one reading, each asked on its own. */
export const sourceOver = (root: string, answers: AdapterAnswers = {}): ReadingSource => readingSource(mo2Context(optionsOver(root, answers)), undefined, DEPLOYED_PATH);

/** The adapter the build composes over `root`, with what `answers` fix. */
export const adapterOver = (root: string, answers: AdapterAnswers = {}): InstanceAdapter =>
  adapterForInstance({ ...optionsOver(root, answers), scriptEnvironmentFileSetting: () => answers.pythonEnvFile });

/** What a test reads back after a command wrote, through the adapter's own reads, so a test never
 *  re-derives a file format of its own. */
export const readInstanceOf = (root: string): Promise<InstanceReading> => adapterOver(root).reading();

export const readModlistEntries = (root: string, profile = 'Default'): Promise<ModlistEntry[]> =>
  sourceOver(root).modOrder(profile);

export const readPluginLines = (root: string, profile = 'Default'): Promise<PluginEntry[]> =>
  sourceOver(root).pluginOrder(profile);

export const readActiveProfile = async (root: string): Promise<string> => (await sourceOver(root).settings()).profile;

/** A downloaded file as the adapter lists it; undefined when it is not listed. */
export async function readDownloadedFile(root: string, name: string): Promise<DownloadedFile | undefined> {
  const { downloadedFiles } = await readInstanceOf(root);
  return expectKind(downloadedFiles, 'listed').files?.find((file) => file.name === name);
}

/** Each listed mod's own files, as a reading holds them. */
export async function modFilesOf(source: ReadingSource, entries: readonly ModlistEntry[]): Promise<Map<string, OriginFiles>> {
  const mods = entries.filter((entry) => entry.kind === 'mod');
  return new Map(await Promise.all(mods.map(async ({ name }) => [name, await source.originFiles({ kind: 'mod', name }, 'list')] as const)));
}

type PluginCommandsClient = Parameters<typeof pluginCommands>[0]['client'];

/** `pluginCommandsWith` over MO2's adapter on `root`. */
export function pluginCommandsOver(root: string, client: Partial<PluginCommandsClient> = {}): PluginCommands {
  return pluginCommandsWith(adapterOver(root), client);
}
