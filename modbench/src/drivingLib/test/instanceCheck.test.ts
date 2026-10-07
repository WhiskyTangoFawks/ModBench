import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ executeCommand: vi.fn(), folders: undefined as { uri: { fsPath: string } }[] | undefined }));
const { executeCommand } = h;
vi.mock('vscode', () => ({
  commands: { executeCommand: h.executeCommand },
  workspace: { get workspaceFolders() { return h.folders; } },
}));

import { openedFolder } from '../instanceCheck';
import { FOLDER_KEY } from '../folderContext';

const writesOfTheKey = () => executeCommand.mock.calls.filter(([command, key]) => command === 'setContext' && key === FOLDER_KEY);

beforeEach(() => {
  executeCommand.mockClear();
  h.folders = undefined;
});

const answerInstanceCheck = (root: string | undefined, isInstance: (root: string) => boolean) => {
  h.folders = root === undefined ? undefined : [{ uri: { fsPath: root } }];
  return openedFolder(isInstance, () => undefined).folder;
};

describe('the instance check', () => {
  it('answers not an instance with no folder open, without asking the mod manager', () => {
    const isInstance = vi.fn(() => true);
    expect(answerInstanceCheck(undefined, isInstance)).toBe('notAnInstance');
    expect(isInstance).not.toHaveBeenCalled();
    expect(writesOfTheKey()).toEqual([['setContext', FOLDER_KEY, 'notAnInstance']]);
  });

  it('answers not an instance for a folder the mod manager does not recognize', () => {
    expect(answerInstanceCheck('/some/folder', () => false)).toBe('notAnInstance');
    expect(writesOfTheKey()).toEqual([['setContext', FOLDER_KEY, 'notAnInstance']]);
  });

  it('answers instance for a folder the mod manager recognizes', () => {
    const isInstance = vi.fn(() => true);
    expect(answerInstanceCheck('/instance', isInstance)).toBe('instance');
    expect(isInstance).toHaveBeenCalledWith('/instance');
    expect(writesOfTheKey()).toEqual([['setContext', FOLDER_KEY, 'instance']]);
  });
});
