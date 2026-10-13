import type {
  ArchiveReader, DownloadMeta, GameFolder, InstanceAdapter, InstanceReading, ModlistEntry, OriginFiles, PluginEntry,
} from '../../instanceAdapter/instanceAdapter';
import type { DownloadsDirectoryResolver } from '../../instanceAdapter/downloadsDirectory';
import type { Mo2Context } from '../../instanceAdapter/mo2Context';
import { downloadsDirectoryResolver } from '../../instanceAdapter/downloadsDirectory';
import { gameDirectoryResolver } from '../../instanceAdapter/gameDirectory';
import { mo2InstanceAdapter } from '../../instanceAdapter/mo2Instance';
import { mo2Watch } from '../../instanceAdapter/mo2Watch';
import { myGamesResolver } from '../../instanceAdapter/myGames';
import { readingSource, type ReadingSource } from '../../instanceAdapter/mo2Reads';
import { buildFileConflictIndex } from '../../instanceLoader/fileConflictIndex';
import { providedPluginsOf } from '../../instanceLoader/loadOrderSnapshot';
import { pluginsCommands, type PluginsCommands } from '../../pluginsCommands/plugins';
import type { Instance } from '../../instanceLoader/instance';
import { fakeArchiveReader } from '../fakeArchiveReader';
import { NO_DETECTORS } from '../noDetectors';

/** What a test fixes in place of asking the machine it runs on. */
export interface AdapterAnswers {
  /** Where the game is, for each read of the settings. */
  gameFolder?: GameFolder | (() => Promise<GameFolder>);
  downloadsFolder?: Awaited<ReturnType<DownloadsDirectoryResolver>>;
  /** What every archive holds; none when the test fixes no reader. */
  archives?: ArchiveReader;
}

/** The downloads folder's answer for a test whose subject holds none: unresolved, watched never. */
export const NO_DOWNLOADS: AdapterAnswers['downloadsFolder'] = { kind: 'unresolved', reason: 'this test reads no downloads' };

/** A window whose focus never changes, for a test whose subject is not the recompute's triggers. */
export const STEADY_WINDOW: ConstructorParameters<typeof Instance>[0]['window'] = {
  state: { focused: true },
  onDidChangeWindowState: () => ({ dispose: () => {} }),
};

/** MO2's context over `root`, detecting no game install, with the answers a test fixes in place. */
export function contextOver(root: string, answers: AdapterAnswers = {}): Mo2Context {
  const { gameFolder, downloadsFolder } = answers;
  return {
    instanceRoot: root,
    resolveGameFolder: gameFolder !== undefined
      ? (typeof gameFolder === 'function' ? gameFolder : () => Promise.resolve(gameFolder))
      : gameDirectoryResolver(() => ({}), NO_DETECTORS),
    resolveDownloadsFolder: downloadsFolder !== undefined ? () => Promise.resolve(downloadsFolder) : downloadsDirectoryResolver(NO_DETECTORS),
    resolveMyGames: myGamesResolver(root, NO_DETECTORS),
    watch: mo2Watch(root, () => ({ dispose: () => {} })),
  };
}

/** The parts of one reading, each asked on its own. */
export const sourceOver = (root: string, answers: AdapterAnswers = {}): ReadingSource => readingSource(contextOver(root, answers));

export const adapterOver = (root: string, answers: AdapterAnswers = {}): InstanceAdapter =>
  mo2InstanceAdapter({
    instanceRoot: root,
    gameDirectoryOverrides: () => ({}),
    gameDirectoryChanged: () => ({ dispose: () => {} }),
    detectors: NO_DETECTORS,
    archives: answers.archives ?? fakeArchiveReader([]),
    context: contextOver(root, answers),
  });

/** What a test reads back after a command wrote, through the adapter's own reads, so a test never
 *  re-derives a file format of its own. `profile` defaults to the corpus fixture's. */
export const readInstanceOf = (root: string): Promise<InstanceReading> => adapterOver(root).reading();

export const readModlistEntries = (root: string, profile = 'Default'): Promise<ModlistEntry[]> =>
  sourceOver(root).modOrder(profile);

export const readPluginLines = (root: string, profile = 'Default'): Promise<PluginEntry[]> =>
  sourceOver(root).pluginOrder(profile);

export const readActiveProfile = async (root: string): Promise<string> => (await sourceOver(root).settings()).profile;

/** A downloaded file's metadata; undefined when it has none. */
export async function readDownloadedFileMeta(root: string, name: string): Promise<DownloadMeta | undefined> {
  const { downloadedFiles } = await readInstanceOf(root);
  if (downloadedFiles.kind !== 'listed') throw new Error(`expected listed, got ${downloadedFiles.reason}`);
  return downloadedFiles.files?.find((file) => file.name === name)?.meta;
}

/** Each listed mod's own files, as a reading holds them. */
export async function modFilesOf(source: ReadingSource, entries: readonly ModlistEntry[]): Promise<Map<string, OriginFiles>> {
  const mods = entries.filter((entry) => entry.kind === 'mod');
  return new Map(await Promise.all(mods.map(async ({ name }) => [name, await source.originFiles({ kind: 'mod', name })] as const)));
}

/** The winners the Instance's value carries for a tree on disk, through the value's own builders. */
export async function providedPluginsIn(root: string, profile = 'Default'): Promise<ReadonlyMap<string, string>> {
  const source = sourceOver(root);
  const entries = await source.modOrder(profile);
  const runtimeOutput = await source.originFiles({ kind: 'runtimeOutput' });
  return providedPluginsOf(buildFileConflictIndex(entries, runtimeOutput.files, await modFilesOf(source, entries), () => {}).files);
}

type PluginsCommandsClient = Parameters<typeof pluginsCommands>[0]['client'];

/** The Plugins commands bound to `adapter` and a client that answers only what a test fixes. */
export function pluginsCommandsWith(adapter: InstanceAdapter, client: Partial<PluginsCommandsClient> = {}): PluginsCommands {
  const unanswered = () => Promise.reject(new Error('this test fixed no answer'));
  return pluginsCommands({
    adapter,
    client: {
      getPlugins: client.getPlugins?.bind(client) ?? unanswered,
      getRenameSourceChanges: client.getRenameSourceChanges?.bind(client) ?? unanswered,
      moveLastWritten: client.moveLastWritten?.bind(client) ?? unanswered,
      getPluginDependants: client.getPluginDependants?.bind(client) ?? unanswered,
    },
  });
}

/** `pluginsCommandsWith` over MO2's adapter on `root`. */
export function pluginsCommandsOver(root: string, client: Partial<PluginsCommandsClient> = {}): PluginsCommands {
  return pluginsCommandsWith(adapterOver(root), client);
}
