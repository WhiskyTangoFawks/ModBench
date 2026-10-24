import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showErrorMessage, showWarningMessage, showInformationMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));
vi.mock('vscode', () => ({ window: { showErrorMessage, showWarningMessage, showInformationMessage } }));

import { makeReporter } from '../reporter';
import { leveledLog } from '../../test/leveledLog';
import type { Reporter } from '../../ports/reporter';

const downloadedFile = (name: string) => ({ name });
const nameOf = (d: { name: string }) => d.name;
const NO_TOAST = { error: [], warning: [], information: [] };
const NO_LINE = { info: [], warn: [], error: [] };

describe('what the user sees of a word Modbench says', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each<[string, string, (reporter: Reporter) => void, object, object]>([
    ['an error is an error toast and an error line, each saying what and why', 'deploy',
      (r) => { r.report('error', 'Deploy failed.', 'disk full'); },
      { ...NO_TOAST, error: ['Deploy failed. — disk full'] }, { ...NO_LINE, error: ['[deploy] Deploy failed. — disk full'] }],
    ['a warning with a reason is a warning toast and a warning line, each saying what and why', 'install',
      (r) => { r.report('warning', 'Installed, but not recorded.', 'meta locked'); },
      { ...NO_TOAST, warning: ['Installed, but not recorded. — meta locked'] }, { ...NO_LINE, warn: ['[install] Installed, but not recorded. — meta locked'] }],
    ['a warning with no reason says only what', 'modList',
      (r) => { r.report('warning', 'Could not read the mod list.'); },
      { ...NO_TOAST, warning: ['Could not read the mod list.'] }, { ...NO_LINE, warn: ['[modList] Could not read the mod list.'] }],
    ['a landed gesture is an information toast and no line', 'deploy',
      (r) => { r.landed('Mods deployed.'); },
      { ...NO_TOAST, information: ['Mods deployed.'] }, NO_LINE],
    ['a failure a dialog already shows is a line, what and why, and no toast', 'recordLifecycle',
      (r) => { r.shownOnSurface('warning', 'Could not fetch a suggested FormKey.', 'backend down'); },
      NO_TOAST, { ...NO_LINE, warn: ['[recordLifecycle] Could not fetch a suggested FormKey. — backend down'] }],
    ['a selection with refusals among its landings is one error naming each refusal and why', 'downloadedFile.delete',
      (r) => {
        r.selectionOutcome('Could not delete 2 downloaded files.', {
          landed: [downloadedFile('A.7z'), downloadedFile('B.7z'), downloadedFile('C.7z')],
          refused: [{ item: downloadedFile('D.7z'), reason: 'in use' }, { item: downloadedFile('E.7z'), reason: 'gone from disk' }],
        }, nameOf);
      },
      { ...NO_TOAST, error: ['Could not delete 2 downloaded files. — "D.7z" (in use), "E.7z" (gone from disk)'] },
      { ...NO_LINE, error: ['[downloadedFile.delete] Could not delete 2 downloaded files. — "D.7z" (in use), "E.7z" (gone from disk)'] }],
    ['a selection that fully landed says nothing', 'downloadedFile.delete',
      (r) => { r.selectionOutcome('Could not delete any downloaded file.', { landed: [downloadedFile('A.7z')], refused: [] }, nameOf); },
      NO_TOAST, NO_LINE],
  ])('%s', (_case, tag, say, toasts, lines) => {
    const channel = leveledLog();
    say(makeReporter(channel, tag));
    expect({
      toasts: {
        error: showErrorMessage.mock.calls.flat(),
        warning: showWarningMessage.mock.calls.flat(),
        information: showInformationMessage.mock.calls.flat(),
      },
      lines: channel.lines,
    }).toEqual({ toasts, lines });
  });
});
