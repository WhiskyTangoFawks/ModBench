import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Uri } from '../../test/vscodeMock';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn(() => Promise.resolve()) }));

vi.mock('vscode', () => ({ commands: { executeCommand }, Uri }));

import { goToRowOrFile } from '../goToRow';
import { recordingReporter } from '../../test/surfacingDoubles';

describe('go to, for an object a view shows as a row and the Explorer as a file', () => {
  beforeEach(() => { executeCommand.mockClear(); });

  function goTo(shown: { row?: string; file?: string }) {
    const reveal = vi.fn((_row: string) => Promise.resolve());
    const reporter = recordingReporter();
    return goToRowOrFile({ name: '"Base"', row: shown.row, file: shown.file, reveal, reporter, nowhere: 'no view and no file shows it.' })
      .then(() => ({ reveal, reporter }));
  }

  it('selects its row', async () => {
    const { reveal, reporter } = await goTo({ row: 'the row', file: '/data/Base' });

    expect([reveal.mock.calls, executeCommand.mock.calls, reporter.reports]).toEqual([[['the row']], [], []]);
  });

  it('shows its file in the Explorer when the view shows no row for it', async () => {
    const { reveal } = await goTo({ file: '/data/Base' });

    expect([reveal.mock.calls, executeCommand.mock.calls]).toEqual([[], [['revealInExplorer', Uri.file('/data/Base')]]]);
  });

  it('says why when there is neither a row nor a file', async () => {
    const { reporter } = await goTo({});

    expect(reporter.reports.map(({ severity, message }) => [severity, message])).toEqual([['error', 'Could not go to "Base": no view and no file shows it.']]);
  });
});
