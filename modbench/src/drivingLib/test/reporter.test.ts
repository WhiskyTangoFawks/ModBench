import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showErrorMessage, showWarningMessage, showInformationMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));
vi.mock('vscode', () => ({ window: { showErrorMessage, showWarningMessage, showInformationMessage } }));

import { makeReporter } from '../reporter';
import type { SelectionOutcome } from '../../ports/selectionOutcome';

function fakeChannelOfEveryLevel() {
  return {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    append: vi.fn(), appendLine: vi.fn(),
  };
}

function channelWrites(channel: ReturnType<typeof fakeChannelOfEveryLevel>): unknown[][] {
  return Object.values(channel).flatMap((spy) => spy.mock.calls);
}

describe('makeReporter', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('logs an error severity to the channel\'s .error() and shows an error toast saying why', () => {
    const channel = fakeChannelOfEveryLevel();
    makeReporter(channel, 'deploy').report('error', 'Deploy failed.', 'disk full');
    expect(channel.error).toHaveBeenCalledWith('[deploy] Deploy failed. — disk full');
    expect(channel.warn).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith('Deploy failed. — disk full');
  });

  it('shows a warning toast saying why when the warning carries a reason', () => {
    const channel = fakeChannelOfEveryLevel();
    makeReporter(channel, 'install').report('warning', 'Installed, but not recorded.', 'meta locked');
    expect(channel.warn).toHaveBeenCalledWith('[install] Installed, but not recorded. — meta locked');
    expect(showWarningMessage).toHaveBeenCalledWith('Installed, but not recorded. — meta locked');
  });

  it('logs a warning severity to the channel\'s .warn() and shows a warning toast', () => {
    const channel = fakeChannelOfEveryLevel();
    makeReporter(channel, 'modList').report('warning', 'Could not read the mod list.');
    expect(channel.warn).toHaveBeenCalledWith('[modList] Could not read the mod list.');
    expect(channel.error).not.toHaveBeenCalled();
    expect(showWarningMessage).toHaveBeenCalledWith('Could not read the mod list.');
  });

  it('shows a landed gesture as an information toast and writes nothing to the log', () => {
    const channel = fakeChannelOfEveryLevel();
    makeReporter(channel, 'deploy').landed('Mods deployed.');
    expect(showInformationMessage).toHaveBeenCalledWith('Mods deployed.');
    expect(channelWrites(channel)).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('writes a failure inside a dialog to the Output, what and why, and shows no notification', () => {
    const channel = fakeChannelOfEveryLevel();
    makeReporter(channel, 'recordLifecycle').shownOnSurface('warning', 'Could not fetch a suggested FormKey.', 'backend down');
    expect(channelWrites(channel)).toEqual([
      ['[recordLifecycle] Could not fetch a suggested FormKey. — backend down'],
    ]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  describe('a selection\'s outcome', () => {
    interface DownloadedFile { name: string; bytes: number }
    const downloadedFile = (name: string): DownloadedFile => ({ name, bytes: 1 });
    const nameOf = (d: DownloadedFile) => d.name;

    it('reports two refusals among three landings as one error toast naming each and why, and one Output line', () => {
      const channel = fakeChannelOfEveryLevel();
      const outcome: SelectionOutcome<DownloadedFile> = {
        landed: [downloadedFile('A.7z'), downloadedFile('B.7z'), downloadedFile('C.7z')],
        refused: [
          { item: downloadedFile('D.7z'), reason: 'in use' },
          { item: downloadedFile('E.7z'), reason: 'gone from disk' },
        ],
      };

      makeReporter(channel, 'downloadedFile.delete').selectionOutcome('Could not delete 2 downloaded files.', outcome, nameOf);

      expect(showErrorMessage.mock.calls).toEqual([
        ['Could not delete 2 downloaded files. — "D.7z" (in use), "E.7z" (gone from disk)'],
      ]);
      expect(channelWrites(channel)).toEqual([
        ['[downloadedFile.delete] Could not delete 2 downloaded files. — "D.7z" (in use), "E.7z" (gone from disk)'],
      ]);
      expect(showWarningMessage).not.toHaveBeenCalled();
      expect(showInformationMessage).not.toHaveBeenCalled();
    });

    it('raises no failure notification and writes nothing for a fully landed outcome', () => {
      const channel = fakeChannelOfEveryLevel();

      makeReporter(channel, 'downloadedFile.delete').selectionOutcome(
        'Could not delete any downloaded file.', { landed: [downloadedFile('A.7z'), downloadedFile('B.7z')], refused: [] }, nameOf);

      expect(showErrorMessage).not.toHaveBeenCalled();
      expect(showWarningMessage).not.toHaveBeenCalled();
      expect(channelWrites(channel)).toEqual([]);
    });
  });
});
