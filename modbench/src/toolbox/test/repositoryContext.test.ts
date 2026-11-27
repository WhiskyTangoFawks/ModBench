import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));

vi.mock('vscode', () => ({
  commands: { executeCommand },
  Uri: { file: (path: string) => ({ toString: () => `file://${path}` }) },
  Disposable: class { constructor(readonly dispose: () => void) {} },
}));

import { publishRepository } from '../repositoryContext';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';

beforeEach(() => { vi.clearAllMocks(); });

const holding = (holdsRepository: boolean, repositorySetUp = false) => instanceValueFixture({ holdsRepository, repositorySetUp });

describe('publishRepository', () => {
  it('tells the menus whether the instance holds a repository, now and from each value the Instance loader lands', () => {
    const instance = new FakeInstance(holding(false));

    publishRepository(instance, '/instance');
    instance.publish(holding(true, true));

    expect(executeCommand.mock.calls).toEqual([
      ['setContext', 'modbench.modlist.instanceRoots', ['file:///instance']],
      ['setContext', 'modbench.modlist.hasRepository', false],
      ['setContext', 'modbench.modlist.repositorySetUp', false],
      ['setContext', 'modbench.modlist.hasRepository', true],
      ['setContext', 'modbench.modlist.repositorySetUp', true],
    ]);
  });

  it('stops listening once disposed', () => {
    const instance = new FakeInstance(holding(true));

    publishRepository(instance, '/instance').dispose();
    executeCommand.mockClear();
    instance.publish(holding(false));

    expect(executeCommand.mock.calls).toEqual([]);
  });
});
