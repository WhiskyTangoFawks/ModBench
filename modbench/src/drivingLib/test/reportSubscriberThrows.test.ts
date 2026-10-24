import { describe, it, expect } from 'vitest';
import { reportSubscriberThrows } from '../reportSubscriberThrows';
import type { ListenerOutcome, ListenerOutcomeListener } from '../../instanceLoader/instance';

const listener = {};

function heard(outcome: ListenerOutcome) {
  const said: unknown[] = [];
  let tell: ListenerOutcomeListener = () => undefined;
  reportSubscriberThrows(
    { onListenerOutcome: (l) => { tell = l; return { dispose: () => undefined }; } },
    {
      threw: (source, message, detail) => said.push({ threw: { source, message, detail } }),
      recovered: (source) => said.push({ recovered: source }),
    },
  );
  tell(outcome);
  return said;
}

describe('a view that did not take an update of the instance', () => {
  it.each<[string, ListenerOutcome, unknown[]]>([
    ['a subscriber that threw on a landed value may be out of date', { listener, during: 'value', threw: 'boom' },
      [{ threw: { source: listener, message: 'A view did not take the instance\'s latest value, so it may be out of date', detail: 'boom' } }]],
    ['a read-failure listener that threw may be out of date', { listener, during: 'read-failure', threw: 'boom' },
      [{ threw: { source: listener, message: 'A view did not take word of the instance\'s failed read, so it may be out of date', detail: 'boom' } }]],
    ['a listener that returned has recovered', { listener, during: 'value', threw: undefined },
      [{ recovered: listener }]],
  ])('%s', (_case, outcome, expected) => {
    expect(heard(outcome)).toEqual(expected);
  });
});
