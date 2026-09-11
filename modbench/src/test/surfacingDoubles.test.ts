import { describe, it, expect } from 'vitest';
import { recordingReporter, scriptedDialog } from './surfacingDoubles';
import { applyRecordEdit } from '../editor/applyRecordEdit';
import {
  runExternalChangeDialogs, BASELINE_BUTTON, APPLY_BUTTON,
} from '../plugins/externalChangeDialog';
import type { UnansweredExternalChange } from '../medit/client';
import type { RecordEditEnvelope } from '../medit/messages';

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

describe('the scripted dialog', () => {
  it('answers each question with the next scripted answer and records what was asked', async () => {
    const dialog = scriptedDialog(BASELINE_BUTTON, APPLY_BUTTON);

    const outcomes = await runExternalChangeDialogs([unanswered('ModA'), unanswered('ModB')], dialog);

    expect(outcomes.map((o) => o.answer)).toEqual(['absorb', 'keep']);
    expect(dialog.asked).toEqual([
      { message: 'ModA', detail: 'Plugin(s) changed: Fixture.esp\nNo version change was observed.', buttons: [APPLY_BUTTON, BASELINE_BUTTON] },
      { message: 'ModB', detail: 'Plugin(s) changed: Fixture.esp\nNo version change was observed.', buttons: [APPLY_BUTTON, BASELINE_BUTTON] },
    ]);
  });

  it('answers a question the script did not reach with the native cancel', async () => {
    const dialog = scriptedDialog(BASELINE_BUTTON);

    const outcomes = await runExternalChangeDialogs([unanswered('ModA'), unanswered('ModB')], dialog);

    expect(outcomes.map((o) => o.answer)).toEqual(['absorb', 'defer']);
    expect(dialog.asked).toHaveLength(2);
  });
});
