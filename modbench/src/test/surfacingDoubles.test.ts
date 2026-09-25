import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showErrorMessage } = vi.hoisted(() => ({ showErrorMessage: vi.fn() }));
vi.mock('vscode', () => ({ window: { showErrorMessage } }));

import { recordingReporter, scriptedDialog } from './surfacingDoubles';
import { makeReporter } from '../reporter';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import { applyRecordEdit } from '../editor/applyRecordEdit';
import {
  runExternalChangeDialogs, messageFor, BASELINE_BUTTON, APPLY_BUTTON,
} from '../plugins/externalChangeDialog';
import type { UnansweredExternalChange } from '../client';
import type { RecordEditEnvelope } from '../wire/messages';

const EDIT: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'X' };

function unanswered(origin: string): UnansweredExternalChange {
  return { origin, plugins: ['Fixture.esp'], trackedFiles: [], metaChanged: false, oldVersion: null, newVersion: null };
}

// Both doubles are driven through a real consumer of the seam, never called directly: a double
// that only satisfies its own test proves nothing about the seam it stands in for.
describe('the recording reporter', () => {
  it('records the severity, message and detail a module reported, in order', async () => {
    const reporter = recordingReporter();
    const meditClient = { editRecord: () => Promise.reject(new Error('backend down')) };

    await applyRecordEdit({ meditClient, onRecordEdited: () => {}, reporter }, '000800', 'A.esp', 'ModA', EDIT);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not edit this record.', detail: 'backend down' },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('records a refusal as a warning with no detail, and a landing separately from a report', async () => {
    const reporter = recordingReporter();
    const meditClient = { editRecord: () => Promise.resolve({ applied: false as const, refusal: 'ReadOnly', message: 'Record is read-only.' }) };

    await applyRecordEdit({ meditClient, onRecordEdited: () => {}, reporter }, '000800', 'A.esp', 'ModA', EDIT);
    reporter.landed('Mods deployed.');

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: 'Record is read-only.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual(['Mods deployed.']);
  });
});

// No command takes a selection yet, so makeReporter is the consumer the double must agree with.
describe('the recording reporter, given a selection\'s outcome', () => {
  beforeEach(() => { showErrorMessage.mockClear(); });

  interface PluginCopy { origin: string; filename: string }
  const nameOf = (p: PluginCopy) => `${p.origin}/${p.filename}`;
  const MESSAGE = 'Could not delete 1 record.';
  const FULLY_LANDED: SelectionOutcome<PluginCopy> = {
    landed: [{ origin: 'ModA', filename: 'A.esp' }], refused: [],
  };
  const ONE_REFUSED: SelectionOutcome<PluginCopy> = {
    landed: [{ origin: 'ModA', filename: 'A.esp' }],
    refused: [{ item: { origin: 'ModB', filename: 'A.esp' }, reason: 'gone from disk' }],
  };

  it('keeps every call with its items as the caller typed them', () => {
    const reporter = recordingReporter();

    reporter.selectionOutcome(MESSAGE, FULLY_LANDED, nameOf);
    reporter.selectionOutcome(MESSAGE, ONE_REFUSED, nameOf);

    expect(reporter.selectionOutcomeCalls).toEqual([
      { message: MESSAGE, outcome: { landed: [{ origin: 'ModA', filename: 'A.esp' }], refused: [] } },
      {
        message: MESSAGE,
        outcome: {
          landed: [{ origin: 'ModA', filename: 'A.esp' }],
          refused: [{ item: { origin: 'ModB', filename: 'A.esp' }, reason: 'gone from disk' }],
        },
      },
    ]);
  });

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

describe('the scripted dialog', () => {
  it('answers each question with the next scripted answer and records what was asked', async () => {
    const changes = [unanswered('ModA'), unanswered('ModB')];
    const dialog = scriptedDialog(BASELINE_BUTTON, APPLY_BUTTON);

    const outcomes = await runExternalChangeDialogs(changes, dialog);

    expect(outcomes.map((o) => o.answer)).toEqual(['absorb', 'keep']);
    // What either question says is externalChangeDialog.test.ts's to pin; what the double owes is
    // that each question reached it whole, in the order the consumer posed them.
    expect(dialog.asked.map((q) => q.message)).toEqual(['ModA', 'ModB']);
    expect(dialog.asked.map((q) => q.detail)).toEqual(changes.map((c) => messageFor(c).detail));
    // Every fixture here is metaChanged: false, so the default order (pinned by
    // externalChangeDialog.test.ts) is Apply first for both.
    expect(dialog.asked.map((q) => q.buttons)).toEqual(changes.map(() => [APPLY_BUTTON, BASELINE_BUTTON]));
  });

  it('answers a question the script did not reach with the native cancel', async () => {
    const dialog = scriptedDialog(BASELINE_BUTTON);

    const outcomes = await runExternalChangeDialogs([unanswered('ModA'), unanswered('ModB')], dialog);

    expect(outcomes.map((o) => o.answer)).toEqual(['absorb', 'defer']);
    expect(dialog.asked).toHaveLength(2);
  });
});
