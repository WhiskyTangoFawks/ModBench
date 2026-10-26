import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showErrorMessage, showWarningMessage, showInformationMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));
vi.mock('vscode', () => ({ window: { showErrorMessage, showWarningMessage, showInformationMessage } }));

import { makeReporter } from '../reporter';
import { leveledLog } from '../../test/leveledLog';
import type { Reporter, Severity } from '../../ports/reporter';
import type { SelectionOutcome } from '../../ports/selectionOutcome';

const downloadedFile = (name: string) => ({ name });
const NO_TOAST = { error: [], warning: [], information: [] };
const NO_LINE = { info: [], warn: [], error: [] };

function heard(tag: string, say: (reporter: Reporter) => void) {
  const channel = leveledLog();
  say(makeReporter(channel, tag));
  return {
    toasts: {
      error: showErrorMessage.mock.calls.flat(),
      warning: showWarningMessage.mock.calls.flat(),
      information: showInformationMessage.mock.calls.flat(),
    },
    lines: channel.lines,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('a failure Modbench reports', () => {
  it.each<[string, string, Severity, string, string | undefined, object, object]>([
    ['an error is an error toast and an error line, each saying what and why', 'deploy', 'error', 'Deploy failed.', 'disk full',
      { ...NO_TOAST, error: ['Deploy failed. — disk full'] }, { ...NO_LINE, error: ['[deploy] Deploy failed. — disk full'] }],
    ['a warning with a reason is a warning toast and a warning line, each saying what and why', 'install', 'warning', 'Installed, but not recorded.', 'meta locked',
      { ...NO_TOAST, warning: ['Installed, but not recorded. — meta locked'] }, { ...NO_LINE, warn: ['[install] Installed, but not recorded. — meta locked'] }],
    ['a warning with no reason says only what', 'modList', 'warning', 'Could not read the mod list.', undefined,
      { ...NO_TOAST, warning: ['Could not read the mod list.'] }, { ...NO_LINE, warn: ['[modList] Could not read the mod list.'] }],
  ])('%s', (_case, tag, severity, message, detail, toasts, lines) => {
    expect(heard(tag, (r) => { r.report(severity, message, detail); })).toEqual({ toasts, lines });
  });
});

describe('a gesture that landed', () => {
  it('is an information toast and no line', () => {
    expect(heard('deploy', (r) => { r.landed('Mods deployed.'); })).toEqual({ toasts: { ...NO_TOAST, information: ['Mods deployed.'] }, lines: NO_LINE });
  });
});

describe('a failure the surface already shows', () => {
  it('is a line, what and why, and no toast', () => {
    expect(heard('recordLifecycle', (r) => { r.shownOnSurface('warning', 'Could not fetch a suggested FormKey.', 'backend down'); }))
      .toEqual({ toasts: NO_TOAST, lines: { ...NO_LINE, warn: ['[recordLifecycle] Could not fetch a suggested FormKey. — backend down'] } });
  });
});

describe('the outcome of a gesture over a selection', () => {
  it('is the tagged error toast and line of its refusals', () => {
    const outcome: SelectionOutcome<{ name: string }> = {
      landed: [downloadedFile('A.7z')],
      refused: [{ item: downloadedFile('D.7z'), reason: 'in use' }, { item: downloadedFile('E.7z'), reason: 'gone from disk' }],
    };

    expect(heard('downloadedFile.delete', (r) => { r.selectionOutcome('Could not delete 2 downloaded files.', outcome, (d) => d.name); })).toEqual({
      toasts: { ...NO_TOAST, error: ['Could not delete 2 downloaded files. — "D.7z" (in use), "E.7z" (gone from disk)'] },
      lines: { ...NO_LINE, error: ['[downloadedFile.delete] Could not delete 2 downloaded files. — "D.7z" (in use), "E.7z" (gone from disk)'] },
    });
  });

  it.each<[string, string | undefined, number]>([
    ['runs its action when the button is clicked', 'Open User Tasks', 1],
    ['runs nothing when the toast is dismissed', undefined, 0],
  ])('offers its action as the toast\'s button, and %s', async (_case, clicked, runs) => {
    const shown = Promise.resolve(clicked);
    showErrorMessage.mockReturnValue(shown);
    const run = vi.fn();
    const outcome: SelectionOutcome<string> = { landed: [], refused: [{ item: 'Mod', reason: 'no task' }] };

    const { toasts } = heard('build', (r) => { r.selectionOutcome('Could not build 1 of 1 mods.', outcome, (mod) => mod, { title: 'Open User Tasks', run }); });
    await shown;

    expect(toasts.error).toEqual(['Could not build 1 of 1 mods. — "Mod" (no task)', 'Open User Tasks']);
    expect(run).toHaveBeenCalledTimes(runs);
  });
});
