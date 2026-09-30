import type { DownloadedFiles, GameFolder, InstanceAdapter, ModlistEntry, PluginEntry } from '../../instanceAdapter/instanceAdapter';
import { mo2InstanceAdapter } from '../../instanceAdapter/mo2Instance';
import { buildFileConflictIndex } from '../../instanceLoader/fileConflictIndex';
import { buildLoadOrderRows, providedPluginsOf } from '../../instanceLoader/loadOrderSnapshot';

/** The adapter's answers a test fixes in place of asking the machine it runs on. */
export interface AdapterAnswers {
  /** Where the game is, for each read of the settings. */
  gameFolder?: GameFolder | (() => Promise<GameFolder>);
  downloadedFiles?: DownloadedFiles | (() => Promise<DownloadedFiles>);
}

/** The downloaded files' answer for a test whose subject holds none: listed nowhere, watched never. */
export const NO_DOWNLOADS: DownloadedFiles = { kind: 'unresolved', reason: 'this test reads no downloads' };

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

/** The winners the Instance's value carries for a tree on disk, built through the value's own
 *  builders: a test handing plugin sync its argument fakes no walk of its own. */
export async function providedPluginsIn(
  root: string, profile = 'Default', dataFolder?: string,
): Promise<ReadonlyMap<string, string>> {
  const adapter = adapterOver(root);
  const [entries, lines, runtimeOutput] = await Promise.all([
    adapter.modOrder(profile), adapter.pluginOrder(profile), adapter.originFiles({ kind: 'runtimeOutput' }),
  ]);
  const index = await buildFileConflictIndex(entries, adapter, () => {});
  return providedPluginsOf(buildLoadOrderRows(lines, index, runtimeOutput.files, dataFolder));
}
