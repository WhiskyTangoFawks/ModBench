import { describe, it, expect } from 'vitest';
import { firstReadOf } from './instanceFirstRead';
import type { InstanceSubscriber, ReadFailureListener } from './instance';
import { instanceValueFixture } from './test/instanceValueFixture';

// ADR-0013: the one path from a landed recompute to a PUT — no gesture, command or view calls
// `request()` itself (asserted by a scan elsewhere); this is the sole wiring that does.
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
      fail: (reason: string) => { instance.readFailure = reason; failureListener?.(reason); },
      land: () => { instance.readFailure = undefined; instance.sequence++; subscriber?.(instanceValueFixture(), instance.sequence); },
    };
    return instance;
  }
  const reporterSpy = () => {
    const reports: string[] = [];
    return { reports, reporter: { report: (_severity: string, _message: string, detail?: string) => { reports.push(detail ?? ''); }, landed: () => {} } };
  };

  it('settles at once, with the failure and one report, when the first read failed before the tree subscribed', async () => {
    const { reports, reporter } = reporterSpy();
    const gate = firstReadOf(fakeInstance({ sequence: 0, readFailure: 'ENOENT modlist.txt' }), reporter);

    await within(gate.settled, 500);

    expect(gate.failure).toBe('ENOENT modlist.txt');
    expect(reports).toEqual(['ENOENT modlist.txt']);
  });

  it('shows the latest failure while nothing has landed, reports once, and clears when a value lands', async () => {
    const instance = fakeInstance({ sequence: 0 });
    const { reports, reporter } = reporterSpy();
    const gate = firstReadOf(instance, reporter);

    instance.fail('ENOENT modlist.txt');
    await within(gate.settled, 500);
    instance.fail('EACCES plugins.txt');

    expect(gate.failure).toBe('EACCES plugins.txt');
    expect(reports).toEqual(['ENOENT modlist.txt']);

    instance.land();
    instance.fail('EISDIR meta.ini'); // after a value: the old rows stay, never an error node
    expect(gate.failure).toBeUndefined();
    expect(reports).toHaveLength(1);
  });
});

// A hang must fail on an explicit assertion, not the test runner's own timeout.
const within = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)),
]);
