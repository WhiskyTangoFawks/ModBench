import type {
  DownloadedFiles, DownloadMeta, GameFolder, InstanceAdapter, ModlistEntry, PluginEntry,
} from '../../instanceAdapter/instanceAdapter';
import { mo2InstanceAdapter } from '../../instanceAdapter/mo2Instance';
import { buildFileConflictIndex } from '../../instanceLoader/fileConflictIndex';
import { providedPluginsOf } from '../../instanceLoader/loadOrderSnapshot';
import type { InstanceOptions } from '../../instanceLoader/instance';

/** The adapter's answers a test fixes in place of asking the machine it runs on. */
export interface AdapterAnswers {
  /** Where the game is, for each read of the settings. */
  gameFolder?: GameFolder | (() => Promise<GameFolder>);
  downloadedFiles?: DownloadedFiles | (() => Promise<DownloadedFiles>);
}

/** The downloaded files' answer for a test whose subject holds none: listed nowhere, watched never. */
export const NO_DOWNLOADS: DownloadedFiles = { kind: 'unresolved', reason: 'this test reads no downloads' };

/** A window whose focus never changes, for a test whose subject is not the recompute's triggers. */
export const STEADY_WINDOW: InstanceOptions['window'] = {
  state: { focused: true },
  onDidChangeWindowState: () => ({ dispose: () => {} }),
};

/** What every command family reaches the instance through, over `root`. */
export function accessTo(root: string, answers: AdapterAnswers = {}): { instanceRoot: string; adapter: InstanceAdapter } {
  return { instanceRoot: root, adapter: adapterOver(root, answers) };
}

/** MO2's adapter over `root`, detecting no game install, with the answers a test fixes in place. */
export function adapterOver(root: string, answers: AdapterAnswers = {}): InstanceAdapter {
  const adapter = mo2InstanceAdapter({
    instanceRoot: root,
    gameDirectoryOverrides: () => ({}),
    detectors: { paths: () => Promise.resolve(null), winePrefix: () => Promise.resolve(null) },
  });
  const { gameFolder, downloadedFiles } = answers;
  return {
    ...adapter,
    async settings() {
      const settings = await adapter.settings();
      return {
        ...settings,
        gameFolder: gameFolder === undefined ? () => settings.gameFolder()
          : typeof gameFolder === 'function' ? gameFolder : () => Promise.resolve(gameFolder),
        downloadedFiles: downloadedFiles === undefined ? () => settings.downloadedFiles()
          : typeof downloadedFiles === 'function' ? downloadedFiles : () => Promise.resolve(downloadedFiles),
      };
    },
  };
}

/** What a test reads back after a command wrote, through the adapter's own reads, so a test never
 *  re-derives a file format of its own. `profile` defaults to the corpus fixture's. */
export const readModlistEntries = (root: string, profile = 'Default'): Promise<ModlistEntry[]> =>
  adapterOver(root).modOrder(profile);

export const readPluginLines = (root: string, profile = 'Default'): Promise<PluginEntry[]> =>
  adapterOver(root).pluginOrder(profile);

export const readActiveProfile = async (root: string): Promise<string> => (await adapterOver(root).settings()).profile;

/** A downloaded file's metadata; undefined when it has none. */
export async function readDownloadedFileMeta(root: string, name: string): Promise<DownloadMeta | undefined> {
  const listed = await (await adapterOver(root).settings()).downloadedFiles();
  if (listed.kind !== 'listed') throw new Error(`expected listed, got ${listed.reason}`);
  return listed.files?.find((file) => file.name === name)?.meta;
}

/** The winners the Instance's value carries for a tree on disk, through the value's own builders. */
export async function providedPluginsIn(root: string, profile = 'Default'): Promise<ReadonlyMap<string, string>> {
  const adapter = adapterOver(root);
  const [entries, runtimeOutput] = await Promise.all([adapter.modOrder(profile), adapter.originFiles({ kind: 'runtimeOutput' })]);
  const index = await buildFileConflictIndex(entries, runtimeOutput.files, adapter, () => {});
  return providedPluginsOf(index.files);
}
