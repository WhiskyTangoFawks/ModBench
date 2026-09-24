import { expect } from 'vitest';
import type { AskQuestion } from '../ports/dialog';
import { reportSelectionOutcome, type Reporter, type Severity } from '../ports/reporter';
import { present } from '../ports/present';
import type { SelectionOutcome } from '../ports/selectionOutcome';

export interface RecordedReport { severity: Severity; message: string; detail?: string }

export interface RecordedSelectionOutcomeCall { message: string; outcome: SelectionOutcome<unknown> }

export interface RecordingReporter extends Reporter {
  readonly reports: RecordedReport[];
  readonly landings: string[];
  readonly dialogFailures: RecordedReport[];
  readonly selectionOutcomeCalls: RecordedSelectionOutcomeCall[];
}

/** ADR-0019's reporter seam, second adapter: a test injects this where production injects
 *  `makeReporter`, and asserts on what the user was told instead of showing it. */
export function recordingReporter(): RecordingReporter {
  const reports: RecordedReport[] = [];
  const landings: string[] = [];
  const dialogFailures: RecordedReport[] = [];
  const selectionOutcomeCalls: RecordedSelectionOutcomeCall[] = [];
  const report: Reporter['report'] = (severity, message, detail) => { reports.push({ severity, message, detail }); };
  return {
    reports,
    landings,
    dialogFailures,
    selectionOutcomeCalls,
    report,
    landed: (message) => { landings.push(message); },
    insideDialog: (severity, message, detail) => { dialogFailures.push({ severity, message, detail }); },
    selectionOutcome: (message, outcome, nameOf) => {
      selectionOutcomeCalls.push({ message, outcome });
      reportSelectionOutcome(report, message, outcome, nameOf);
    },
  };
}

export interface RecordedQuestion { message: string; detail?: string; buttons: string[] }

export type ScriptedDialog = AskQuestion & { readonly asked: RecordedQuestion[] };

/** ADR-0019's dialog seam, second adapter: answers each question with the next scripted answer.
 *  Running past the script answers `undefined` — the native cancel every modal already carries. */
export function scriptedDialog(...answers: readonly (string | undefined)[]): ScriptedDialog {
  const asked: RecordedQuestion[] = [];
  let next = 0;
  const ask: AskQuestion = (message, options, ...buttons) => {
    asked.push({ message, detail: options.detail, buttons });
    return Promise.resolve(answers[next++]);
  };
  return Object.assign(ask, { asked });
}

// expect.stringContaining's type is `any`, so this checks the one asked question by hand instead
// of embedding the matcher in a toEqual array.
export function assertAskedOnce(
  ask: ScriptedDialog, expected: { messageContains: string; buttons: string[] },
): void {
  expect(ask.asked).toHaveLength(1);
  const call = present(ask.asked[0], 'the one recorded question');
  expect(call.message).toContain(expected.messageContains);
  expect(call.detail).toBeUndefined();
  expect(call.buttons).toEqual(expected.buttons);
}

// Same reason as assertAskedOnce: a refusal's exact wording is not the contract, only that it
// names the item, so this checks `reason` by hand instead of embedding a matcher in `toEqual`.
export function assertSelectionOutcome<T>(
  outcome: SelectionOutcome<T>,
  expected: { landed: readonly T[]; refused: readonly { item: T; reasonContains: string }[] },
): void {
  expect(outcome.landed).toEqual(expected.landed);
  expect(outcome.refused.map((r) => r.item)).toEqual(expected.refused.map((r) => r.item));
  outcome.refused.forEach((refusal, i) => {
    expect(refusal.reason).toContain(present(expected.refused[i], 'the matching expected refusal').reasonContains);
  });
}
