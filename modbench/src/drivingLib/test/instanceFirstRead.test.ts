import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeInstance } from '../../test/mo2/fakeInstance';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));
vi.mock('vscode', () => ({ commands: { executeCommand } }));

import { firstReadOf, markFirstReadLanded } from '../instanceFirstRead';
import { INSTANCE_READ_KEY } from '../../test/manifest';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

describe('a tree\'s first-render gate', () => {
  it('settles at once, with the failure, when the first read failed before the tree subscribed', async () => {
    const instance = new FakeInstance(instanceValueFixture(), 0);
    instance.readFailure = 'ENOENT modlist.txt';
    const gate = firstReadOf(instance);

    await gate.settled;

    expect(gate.failure).toBe('ENOENT modlist.txt');
  });

  it('shows the latest failure while nothing has landed, clears when a value lands and stays clear when a later read fails', async () => {
    const instance = new FakeInstance(instanceValueFixture(), 0);
    const gate = firstReadOf(instance);

    instance.fail('ENOENT modlist.txt');
    await gate.settled;
    instance.fail('EACCES plugins.txt');

    expect(gate.failure).toBe('EACCES plugins.txt');

    instance.publish(instanceValueFixture());
    instance.fail('EISDIR meta.ini');
    expect(gate.failure).toBeUndefined();
  });
});

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
