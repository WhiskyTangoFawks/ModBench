import type { GameFolder } from '../../instanceAdapter/gameDirectory';
import type { DownloadedFiles, InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { mo2InstanceAdapter } from '../../instanceAdapter/mo2Instance';
import type { WatchFiles } from '../../instanceAdapter/mo2Watch';

/** The adapter's answers a test fixes in place of asking the machine it runs on. */
export interface AdapterAnswers {
  /** Where the game is, for each read of the settings. */
  gameFolder?: GameFolder | (() => Promise<GameFolder>);
  downloadedFiles?: DownloadedFiles | (() => Promise<DownloadedFiles>);
  /** Watches nothing when omitted. */
  watchFiles?: WatchFiles;
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
    watchFiles: answers.watchFiles ?? (() => ({ dispose: () => undefined })),
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
