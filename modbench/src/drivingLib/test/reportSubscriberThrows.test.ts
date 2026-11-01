import { describe, it, expect } from 'vitest';
import { reportSubscriberThrows } from '../reportSubscriberThrows';
import type { ListenerOutcome, ListenerOutcomeListener } from '../../instanceLoader/instance';
import { tagRecordingReporterFor } from '../../test/surfacingDoubles';

const listener = {};
const threw: ListenerOutcome = { listener, during: 'value', threw: 'boom' };

function heard(...outcomes: ListenerOutcome[]) {
  const { reporter, tags, reporterFor } = tagRecordingReporterFor();
  let tell: ListenerOutcomeListener = () => undefined;
  reportSubscriberThrows({ onListenerOutcome: (l) => { tell = l; return { dispose: () => undefined }; } }, reporterFor);
  for (const outcome of outcomes) tell(outcome);
  return { reporter, tags };
}

describe('a view that did not take an update of the instance', () => {
  it.each<[string, ListenerOutcome, string]>([
    ['a subscriber that threw on a landed value may be out of date', threw, 'A view did not take the instance\'s latest value, so it may be out of date'],
    ['a read-failure listener that threw may be out of date', { listener, during: 'read-failure', threw: 'boom' }, 'A view did not take word of the instance\'s failed read, so it may be out of date'],
  ])('%s', (_case, outcome, message) => {
    expect(heard(outcome).reporter.reports).toEqual([{ severity: 'error', message, detail: 'boom' }]);
  });

  it('is reported under the instance tag', () => {
    expect(heard().tags).toEqual(['instance']);
  });

  it('a listener that returned has recovered, so its next throw is a report again, not a repeat', () => {
    const { reporter } = heard(threw, threw, { listener, during: 'value', threw: undefined }, threw);
    expect([reporter.reports.length, reporter.shownFailures.length]).toEqual([2, 1]);
  });
});
