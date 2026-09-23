import { describe, it, expect, vi, beforeEach } from 'vitest';

// makeReporter is the ADR-0019 surfacing reporter (log always, toast on warning/error), pulled
// out of extension.ts — which imports the real 'vscode' module — so its severity→level dispatch
// has a real seam.
const { showErrorMessage, showWarningMessage, showInformationMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));
vi.mock('vscode', () => ({ window: { showErrorMessage, showWarningMessage, showInformationMessage } }));

import { makeReporter } from '../reporter';
import type { SelectionOutcome } from '../ports/selectionOutcome';

// Every level a real LogOutputChannel offers, not just the two the parameter type admits, so a
// test can assert a landing wrote *nothing* rather than only that it skipped warn and error.
function fakeChannel() {
  return {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    append: vi.fn(), appendLine: vi.fn(),
  };
}

function channelWrites(channel: ReturnType<typeof fakeChannel>): unknown[][] {
  return Object.values(channel).flatMap((spy) => spy.mock.calls);
}

describe('makeReporter', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('logs an error severity to the channel\'s .error() and shows an error toast saying why', () => {
    const channel = fakeChannel();
    makeReporter(channel, 'deploy').report('error', 'Deploy failed.', 'disk full');
    expect(channel.error).toHaveBeenCalledWith('[deploy] error: Deploy failed. — disk full');
    expect(channel.warn).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Deploy failed. — disk full');
  });

  it('shows a warning toast saying why when the warning carries a reason', () => {
    const channel = fakeChannel();
    makeReporter(channel, 'install').report('warning', 'Installed, but not recorded.', 'meta locked');
    expect(channel.warn).toHaveBeenCalledWith('[install] warning: Installed, but not recorded. — meta locked');
    expect(showWarningMessage).toHaveBeenCalledWith('Modbench: Installed, but not recorded. — meta locked');
  });

  it('logs a warning severity to the channel\'s .warn() and shows a warning toast', () => {
    const channel = fakeChannel();
    makeReporter(channel, 'modList').report('warning', 'Could not read the mod list.');
    expect(channel.warn).toHaveBeenCalledWith('[modList] warning: Could not read the mod list.');
    expect(channel.error).not.toHaveBeenCalled();
    expect(showWarningMessage).toHaveBeenCalledWith('Modbench: Could not read the mod list.');
  });

  it('shows a landed gesture as an information toast and writes nothing to the log', () => {
    const channel = fakeChannel();
    makeReporter(channel, 'deploy').landed('Mods deployed.');
    expect(showInformationMessage).toHaveBeenCalledWith('Modbench: Mods deployed.');
    expect(channelWrites(channel)).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('writes a failure inside a dialog to the Output, what and why, and shows no notification', () => {
    const channel = fakeChannel();
    makeReporter(channel, 'recordLifecycle').insideDialog('warning', 'Could not fetch a suggested FormKey.', 'backend down');
    expect(channelWrites(channel)).toEqual([
      ['[recordLifecycle] warning: Could not fetch a suggested FormKey. — backend down'],
    ]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  describe('a selection\'s outcome', () => {
    interface Download { name: string; bytes: number }
    const download = (name: string): Download => ({ name, bytes: 1 });
    const nameOf = (d: Download) => d.name;

    it('reports two refusals among three landings as one error toast naming each and why, and one Output line', () => {
      const channel = fakeChannel();
      const outcome: SelectionOutcome<Download> = {
        landed: [download('A.7z'), download('B.7z'), download('C.7z')],
        refused: [
          { item: download('D.7z'), reason: 'in use' },
          { item: download('E.7z'), reason: 'gone from disk' },
        ],
      };

      makeReporter(channel, 'downloads.delete').selectionOutcome('Could not delete 2 downloads.', outcome, nameOf);

      expect(showErrorMessage.mock.calls).toEqual([
        ['Modbench: Could not delete 2 downloads. — "D.7z" (in use), "E.7z" (gone from disk)'],
      ]);
      expect(channelWrites(channel)).toEqual([
        ['[downloads.delete] error: Could not delete 2 downloads. — "D.7z" (in use), "E.7z" (gone from disk)'],
      ]);
      expect(showWarningMessage).not.toHaveBeenCalled();
      expect(showInformationMessage).not.toHaveBeenCalled();
    });

    it('raises no failure notification and writes nothing for a fully landed outcome', () => {
      const channel = fakeChannel();

      makeReporter(channel, 'downloads.delete').selectionOutcome(
        'Could not delete any download.', { landed: [download('A.7z'), download('B.7z')], refused: [] }, nameOf);

      expect(showErrorMessage).not.toHaveBeenCalled();
      expect(showWarningMessage).not.toHaveBeenCalled();
      expect(channelWrites(channel)).toEqual([]);
    });
  });
});
