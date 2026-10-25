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

const open = (...roots: string[]) => { h.folders = roots.map((fsPath) => ({ uri: { fsPath } })); };

const answerInstanceCheck = (root: string | undefined, isInstance: (root: string) => boolean) => {
  if (root === undefined) h.folders = undefined; else open(root);
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

describe('several open folders', () => {
  const instances = new Set(['/instanceA', '/instanceB']);
  const isInstance = (root: string) => instances.has(root);

  it('opens the first folder that is an instance, whatever its place in the list', () => {
    open('/repo', '/instanceA', '/instanceB');
    expect(openedFolder(isInstance, () => undefined)).toEqual({ folder: 'instance', instanceRoot: '/instanceA' });
  });

  it('names each other instance in the log, never a plain folder', () => {
    open('/repo', '/instanceA', '/instanceB');
    const log = vi.fn();
    openedFolder(isInstance, log);
    const lines = log.mock.calls.map(([line]) => line as string);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/instanceB');
    expect(lines[0]).not.toContain('/repo');
  });

  it('says nothing of other instances when there is one', () => {
    open('/repo', '/instanceA');
    const log = vi.fn();
    openedFolder(isInstance, log);
    expect(log).not.toHaveBeenCalled();
  });

  it('answers the check before trust for an instance behind another folder', () => {
    h.isTrusted = false;
    open('/repo', '/instanceA');
    afterTrust(isInstance, () => undefined);
    expect(writesOfTheKey()).toEqual([['setContext', FOLDER_KEY, 'untrustedInstance']]);
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
