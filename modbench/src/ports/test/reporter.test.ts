import { describe, it, expect } from 'vitest';
import { reportSelectionOutcome } from '../reporter';
import type { SelectionOutcome } from '../selectionOutcome';
import { recordingReporter, type RecordedReport } from '../../test/surfacingDoubles';

describe('the outcome of a gesture over a selection', () => {
  it.each<[string, SelectionOutcome<{ name: string }>, RecordedReport[]]>([
    ['refusals among its landings are one error naming each refusal and why', {
      landed: [{ name: 'A.7z' }],
      refused: [{ item: { name: 'D.7z' }, reason: 'in use' }, { item: { name: 'E.7z' }, reason: 'gone from disk' }],
    }, [{ severity: 'error', message: 'Could not delete 2 downloaded files.', detail: '"D.7z" (in use), "E.7z" (gone from disk)' }]],
    ['a selection that fully landed says nothing', { landed: [{ name: 'A.7z' }], refused: [] }, []],
  ])('%s', (_case, outcome, reports) => {
    const reporter = recordingReporter();

    reportSelectionOutcome(reporter.report, 'Could not delete 2 downloaded files.', outcome, (d) => d.name);

    expect(reporter.reports).toEqual(reports);
  });
});
