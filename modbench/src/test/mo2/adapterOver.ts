import type {
  InstallationFileReader, DownloadedFile, GameFolder, InstanceAdapter, InstanceReading, ModlistEntry, OriginFiles, PluginEntry, Subscription,
} from '../../instanceAdapter/instanceAdapter';
import type { DownloadsDirectoryResolver } from '../../instanceAdapter/mo2/downloadsDirectory';
import type { Mo2Context } from '../../instanceAdapter/mo2/mo2Context';
import { downloadsDirectoryResolver } from '../../instanceAdapter/mo2/downloadsDirectory';
import { gameFolderResolver, type GameDetectors } from '../../instanceAdapter/gameFolder/gameFolderResolver';
import { adapterForInstance } from '../../instanceAdapter/openInstance';
import { mo2InstanceAdapter } from '../../instanceAdapter/mo2/mo2Instance';
import type { ConfigurationFile, ManagerAdapter } from '../../instanceAdapter/publisher';
import { mo2Watch } from '../../instanceAdapter/mo2/mo2Watch';
import { myGamesResolver } from '../../instanceAdapter/gameFolder/myGames';
import type { ReadingSource } from '../../instanceAdapter/instanceReading';
import { readingSource } from '../../instanceAdapter/mo2/mo2Reads';
import type { PluginCommands, pluginCommands } from '../../pluginCommands/plugins';
import { pluginCommandsWith } from '../pluginCommandsWith';
import { fakeInstallationFileReader } from '../fakeInstallationFileReader';
import { NO_DETECTORS } from '../noDetectors';
import { fixedGameFolderSetting } from '../gameFolderSetting';
import { FOMOD_ENGINE } from '../fomodEngine';
import { expectKind } from '../expectKind';

/** What a test fixes in place of asking the machine it runs on. */
export interface AdapterAnswers {
  /** Where the game is, for each read of the settings. */
  gameFolder?: GameFolder | (() => Promise<GameFolder>);
  downloadsFolder?: Awaited<ReturnType<DownloadsDirectoryResolver>>;
  /** What every installation file holds; none when the test fixes no reader. */
  installationFileReader?: InstallationFileReader;
  /** The setting that names the game's folder. */
  gameFolderSettingValue?: string;
  gameFolderSettingChanged?: (listener: () => void) => Subscription;
  detectors?: GameDetectors;
  mo2Running?: () => Promise<boolean>;
}

/** MO2's context over `root`, detecting no game install, with the answers a test fixes in place. */
export function contextOver(root: string, answers: AdapterAnswers = {}): Mo2Context {
  const {
    gameFolder, downloadsFolder, gameFolderSettingValue, gameFolderSettingChanged, detectors = NO_DETECTORS, mo2Running = () => Promise.resolve(false),
  } = answers;
  const setting = fixedGameFolderSetting(gameFolderSettingValue, gameFolderSettingChanged);
  return {
    instanceRoot: root,
    resolveGameFolder: gameFolder !== undefined
      ? (typeof gameFolder === 'function' ? gameFolder : () => Promise.resolve(gameFolder))
      : gameFolderResolver(setting, detectors),
    resolveDownloadsFolder: downloadsFolder !== undefined ? () => Promise.resolve(downloadsFolder) : downloadsDirectoryResolver(detectors),
    resolveMyGames: myGamesResolver(root, detectors),
    watch: mo2Watch(root, setting.changed),
    mo2Running,
  };
}

/** The parts of one reading, each asked on its own. */
export const sourceOver = (root: string, answers: AdapterAnswers = {}): ReadingSource => readingSource(contextOver(root, answers), undefined);

export const managerOver = (root: string, answers: AdapterAnswers = {}, publisherFile?: ConfigurationFile): ManagerAdapter => mo2InstanceAdapter({
  instanceRoot: root, installationFileReader: answers.installationFileReader ?? fakeInstallationFileReader([]), fomodEngine: FOMOD_ENGINE, context: contextOver(root, answers),
}, publisherFile);

/** The adapter the build composes over `root`, MO2's context fixed as `answers` say. */
export const adapterOver = (root: string, answers: AdapterAnswers = {}): InstanceAdapter =>
  adapterForInstance({ instanceRoot: root, installationFileReader: answers.installationFileReader ?? fakeInstallationFileReader([]), fomodEngine: FOMOD_ENGINE, context: contextOver(root, answers) });

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
