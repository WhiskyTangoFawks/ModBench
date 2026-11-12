import { describe, expect, it, vi } from 'vitest';

const folders = vi.hoisted(() => ({ held: [] as { uri: { scheme: string; fsPath: string } }[] }));
vi.mock('vscode', () => ({ workspace: { get workspaceFolders() { return folders.held; }, onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }) } }));

import { openRoots, workspaceFolders } from '../workspaceFolders';

describe('the folders of the workspace on disk', () => {
  it('leaves out a folder that is not a file, as an archive joined as a folder is not', () => {
    folders.held = [{ uri: { scheme: 'file', fsPath: '/instance' } }, { uri: { scheme: 'modbench-archive', fsPath: '/mods/A.ba2' } }];

    expect(openRoots()).toEqual(['/instance']);
  });

  it.each([
    ['holds a path inside a file folder', '/instance/mods/A', true],
    ['holds nothing inside a folder that is not a file', '/mods/A.ba2/x', false],
  ])('%s', (_case, path, held) => {
    folders.held = [{ uri: { scheme: 'file', fsPath: '/instance' } }, { uri: { scheme: 'modbench-archive', fsPath: '/mods/A.ba2' } }];

    expect(workspaceFolders.holds(path)).toBe(held);
  });
});
