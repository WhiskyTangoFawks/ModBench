import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  folders: undefined as { uri: { fsPath: string } }[] | undefined,
  isTrusted: true,
  grantTrust: (): void => undefined,
}));
const { executeCommand } = h;
vi.mock('vscode', () => ({
  commands: { executeCommand: h.executeCommand },
  workspace: {
    get workspaceFolders() { return h.folders; },
    get isTrusted() { return h.isTrusted; },
    onDidGrantWorkspaceTrust: (listener: () => void) => {
      h.grantTrust = listener;
      return { dispose: () => undefined };
    },
  },
}));

import { afterTrust, openedFolder } from '../instanceCheck';
import { FOLDER_KEY } from '../../test/manifest';

const writesOfTheKey = () => executeCommand.mock.calls.filter(([command, key]) => command === 'setContext' && key === FOLDER_KEY);

beforeEach(() => {
  executeCommand.mockClear();
  h.folders = undefined;
  h.isTrusted = true;
});

const answerInstanceCheck = (root: string | undefined, isInstance: (root: string) => boolean) => {
  h.folders = root === undefined ? undefined : [{ uri: { fsPath: root } }];
  return openedFolder(isInstance, () => undefined).folder;
};

describe('the instance check', () => {
  it.each<[string, string | undefined, (root: string) => boolean, string]>([
    ['not an instance with no folder open, whatever the mod manager would say', undefined, () => true, 'notAnInstance'],
    ['not an instance for a folder the mod manager does not recognize', '/some/folder', () => false, 'notAnInstance'],
    ['instance for the folder the mod manager recognizes', '/instance', (asked) => asked === '/instance', 'instance'],
  ])('answers %s', (_case, root, isInstance, answer) => {
    expect(answerInstanceCheck(root, isInstance)).toBe(answer);
    expect(writesOfTheKey()).toEqual([['setContext', FOLDER_KEY, answer]]);
  });
});

describe('Modbench in a folder by its trust', () => {
  it('starts at once in a trusted folder', () => {
    const start = vi.fn();
    afterTrust(() => true, start);
    expect(start).toHaveBeenCalledOnce();
  });

  it('starts in an untrusted folder only once the folder is trusted', () => {
    h.isTrusted = false;
    const start = vi.fn();
    afterTrust(() => true, start);
    expect(start).not.toHaveBeenCalled();
    h.grantTrust();
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([
    ['an instance', true, 'untrustedInstance'],
    ['a folder the mod manager does not recognize', false, 'notAnInstance'],
  ])('answers the check before trust for %s', (_name, recognized, answer) => {
    h.isTrusted = false;
    h.folders = [{ uri: { fsPath: '/folder' } }];
    afterTrust(() => recognized, () => undefined);
    expect(writesOfTheKey()).toEqual([['setContext', FOLDER_KEY, answer]]);
  });
});
