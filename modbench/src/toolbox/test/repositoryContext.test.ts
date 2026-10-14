import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));

vi.mock('vscode', () => ({
  commands: { executeCommand },
  Uri: { file: (path: string) => ({ toString: () => `file://${path}` }) },
  Disposable: class { constructor(readonly dispose: () => void) {} },
}));

import { publishRepository } from '../repositoryContext';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { InstanceSubscriber } from '../../instanceLoader/instance';

beforeEach(() => { vi.clearAllMocks(); });

function instanceThatLands() {
  const subscribers: (() => void)[] = [];
  const disposed: true[] = [];
  return {
    instance: {
      subscribe: (subscriber: InstanceSubscriber) => {
        subscribers.push(() => { subscriber(instanceValueFixture(), 1); });
        return { dispose: () => { disposed.push(true); } };
      },
    },
    land: () => { for (const subscriber of subscribers) subscriber(); },
    disposed,
  };
}

describe('publishRepository', () => {
  it('tells the menus whether the instance holds a repository, now and after each value the Instance loader lands', async () => {
    let held = false;
    const { instance, land } = instanceThatLands();

    publishRepository(instance, '/instance', () => Promise.resolve(held));
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(2));
    held = true;
    land();
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(3));

    expect(executeCommand.mock.calls).toEqual([
      ['setContext', 'modbench.modlist.instanceRoots', ['file:///instance']],
      ['setContext', 'modbench.modlist.hasRepository', false],
      ['setContext', 'modbench.modlist.hasRepository', true],
    ]);
  });

  it('stops listening once disposed', () => {
    const { instance, disposed } = instanceThatLands();

    publishRepository(instance, '/instance', () => Promise.resolve(true)).dispose();

    expect(disposed).toEqual([true]);
  });
});
