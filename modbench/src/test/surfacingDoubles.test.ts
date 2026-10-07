import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showErrorMessage } = vi.hoisted(() => ({ showErrorMessage: vi.fn() }));
vi.mock('vscode', () => ({ window: { showErrorMessage } }));

import { recordingReporter } from './surfacingDoubles';
import { makeReporter } from '../reporter';
import type { SelectionOutcome } from '../ports/selectionOutcome';

describe('the recording reporter, given a selection\'s outcome', () => {
  beforeEach(() => { showErrorMessage.mockClear(); });

  interface PluginAddress { origin: string; filename: string }
  const nameOf = (p: PluginAddress) => `${p.origin}/${p.filename}`;
  const MESSAGE = 'Could not delete 1 record.';
  const FULLY_LANDED: SelectionOutcome<PluginAddress> = {
    landed: [{ origin: 'ModA', filename: 'A.esp' }], refused: [],
  };
  const ONE_REFUSED: SelectionOutcome<PluginAddress> = {
    landed: [{ origin: 'ModA', filename: 'A.esp' }],
    refused: [{ item: { origin: 'ModB', filename: 'A.esp' }, reason: 'gone from disk' }],
  };

  it('reports nothing for a fully landed outcome, as makeReporter surfaces nothing', () => {
    const reporter = recordingReporter();

    reporter.selectionOutcome(MESSAGE, FULLY_LANDED, nameOf);
    makeReporter({ warn: vi.fn(), error: vi.fn() }, 'records.delete').selectionOutcome(MESSAGE, FULLY_LANDED, nameOf);

    expect(reporter.reports).toEqual([]);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('reports a refusal as the one error makeReporter surfaces', () => {
    const reporter = recordingReporter();

    reporter.selectionOutcome(MESSAGE, ONE_REFUSED, nameOf);
    makeReporter({ warn: vi.fn(), error: vi.fn() }, 'records.delete').selectionOutcome(MESSAGE, ONE_REFUSED, nameOf);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: MESSAGE, detail: '"ModB/A.esp" (gone from disk)' },
    ]);
    expect(showErrorMessage.mock.calls).toEqual([
      ['Modbench: Could not delete 1 record. — "ModB/A.esp" (gone from disk)'],
    ]);
  });
});
