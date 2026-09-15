import { expect } from 'vitest';
import type { AskQuestion } from '../dialog';
import type { Reporter, Severity } from '../reporter';
import { present } from '../present';

export interface RecordedReport { severity: Severity; message: string; detail?: string }

export interface RecordingReporter extends Reporter {
  readonly reports: RecordedReport[];
  readonly landings: string[];
}

/** ADR-0019's reporter seam, second adapter: a test injects this where production injects
 *  `makeReporter`, and asserts on what the user was told instead of showing it. */
export function recordingReporter(): RecordingReporter {
  const reports: RecordedReport[] = [];
  const landings: string[] = [];
  return {
    reports,
    landings,
    report: (severity, message, detail) => { reports.push({ severity, message, detail }); },
    landed: (message) => { landings.push(message); },
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
