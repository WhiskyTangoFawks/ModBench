import { describe, it, expect } from 'vitest';
import { firstReadOf } from '../instanceFirstRead';
import type { InstanceSubscriber, ReadFailureListener } from '../../instanceLoader/instance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

describe('firstReadOf', () => {
  // The Instance as a tree constructed at any moment sees it: a failure may already be held.
  function fakeInstance(initial: { sequence: number; readFailure?: string }) {
    let failureListener: ReadFailureListener | undefined;
    let subscriber: InstanceSubscriber | undefined;
    const instance = {
      sequence: initial.sequence,
      readFailure: initial.readFailure,
      subscribe: (fn: InstanceSubscriber) => { subscriber = fn; return { dispose: () => {} }; },
      onReadFailure: (fn: ReadFailureListener) => { failureListener = fn; return { dispose: () => {} }; },
      fail: (reason: string) => { instance.readFailure = reason; failureListener?.(); },
      land: () => { instance.readFailure = undefined; instance.sequence++; subscriber?.(instanceValueFixture(), instance.sequence); },
    };
    return instance;
  }

  it('settles at once, with the failure, when the first read failed before the tree subscribed', async () => {
    const gate = firstReadOf(fakeInstance({ sequence: 0, readFailure: 'ENOENT modlist.txt' }));

    await within(gate.settled, 500);

    expect(gate.failure).toBe('ENOENT modlist.txt');
  });

  it('shows the latest failure while nothing has landed, and clears when a value lands', async () => {
    const instance = fakeInstance({ sequence: 0 });
    const gate = firstReadOf(instance);

    instance.fail('ENOENT modlist.txt');
    await within(gate.settled, 500);
    instance.fail('EACCES plugins.txt');

    expect(gate.failure).toBe('EACCES plugins.txt');

    instance.land();
    instance.fail('EISDIR meta.ini'); // after a value: the old rows stay, never an error row
    expect(gate.failure).toBeUndefined();
  });
});

// A hang must fail on an explicit assertion, not the test runner's own timeout.
const within = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)),
]);
