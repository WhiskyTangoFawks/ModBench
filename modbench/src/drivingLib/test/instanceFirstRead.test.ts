import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeInstance } from '../../test/mo2/fakeInstance';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));
vi.mock('vscode', () => ({ commands: { executeCommand } }));

import { firstReadOf, markFirstReadLanded } from '../instanceFirstRead';
import { INSTANCE_READ_KEY } from '../folderContext';
import type { InstanceSubscriber, ReadFailureListener } from '../../instanceLoader/instance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

describe('firstReadOf', () => {
  function fakeInstanceThatMayAlreadyHoldAFailure(initial: { sequence: number; readFailure?: string }) {
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
    const gate = firstReadOf(fakeInstanceThatMayAlreadyHoldAFailure({ sequence: 0, readFailure: 'ENOENT modlist.txt' }));

    await explicitFailureIfNotSettledWithin(gate.settled, 500);

    expect(gate.failure).toBe('ENOENT modlist.txt');
  });

  it('shows the latest failure while nothing has landed, clears when a value lands and stays clear when a later read fails', async () => {
    const instance = fakeInstanceThatMayAlreadyHoldAFailure({ sequence: 0 });
    const gate = firstReadOf(instance);

    instance.fail('ENOENT modlist.txt');
    await explicitFailureIfNotSettledWithin(gate.settled, 500);
    instance.fail('EACCES plugins.txt');

    expect(gate.failure).toBe('EACCES plugins.txt');

    instance.land();
    instance.fail('EISDIR meta.ini');
    expect(gate.failure).toBeUndefined();
  });
});

const explicitFailureIfNotSettledWithin = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)),
]);

beforeEach(() => { executeCommand.mockClear(); });

const writesOfTheReadKey = () =>
  executeCommand.mock.calls.filter(([command, key]) => command === 'setContext' && key === INSTANCE_READ_KEY);

describe("the instance's first read", () => {
  const unread = () => new FakeInstance(instanceValueFixture(), 0);

  it('leaves the key unset until a value lands', () => {
    markFirstReadLanded(unread());
    expect(writesOfTheReadKey()).toEqual([]);
  });

  it('leaves the key unset through a failed read, and sets it when the next read lands', () => {
    const instance = unread();
    markFirstReadLanded(instance);
    instance.fail('ModOrganizer.ini is empty');
    expect(writesOfTheReadKey()).toEqual([]);
    instance.publish(instanceValueFixture());
    expect(writesOfTheReadKey()).toEqual([['setContext', INSTANCE_READ_KEY, true]]);
  });

  it('sets the key once the first value lands, and never again', () => {
    const instance = unread();
    markFirstReadLanded(instance);
    instance.publish(instanceValueFixture());
    instance.publish(instanceValueFixture());
    expect(writesOfTheReadKey()).toEqual([['setContext', INSTANCE_READ_KEY, true]]);
  });

  it('stops listening when disposed before any value lands', () => {
    const instance = unread();
    markFirstReadLanded(instance).dispose();
    instance.publish(instanceValueFixture());
    expect(writesOfTheReadKey()).toEqual([]);
  });
});
