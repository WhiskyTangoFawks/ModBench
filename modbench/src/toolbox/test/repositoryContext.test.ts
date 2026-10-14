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

function instanceHolding(holdsRepository: boolean) {
  const subscribers: InstanceSubscriber[] = [];
  const disposed: true[] = [];
  return {
    instance: {
      value: instanceValueFixture({ holdsRepository }),
      subscribe: (subscriber: InstanceSubscriber) => {
        subscribers.push(subscriber);
        return { dispose: () => { disposed.push(true); } };
      },
    },
    land: (held: boolean) => { for (const subscriber of subscribers) subscriber(instanceValueFixture({ holdsRepository: held }), 1); },
    disposed,
  };
}

describe('publishRepository', () => {
  it('tells the menus whether the instance holds a repository, now and from each value the Instance loader lands', () => {
    const { instance, land } = instanceHolding(false);

    publishRepository(instance, '/instance');
    land(true);

    expect(executeCommand.mock.calls).toEqual([
      ['setContext', 'modbench.modlist.instanceRoots', ['file:///instance']],
      ['setContext', 'modbench.modlist.hasRepository', false],
      ['setContext', 'modbench.modlist.hasRepository', true],
    ]);
  });

  it('stops listening once disposed', () => {
    const { instance, disposed } = instanceHolding(true);

    publishRepository(instance, '/instance').dispose();

    expect(disposed).toEqual([true]);
  });
});
