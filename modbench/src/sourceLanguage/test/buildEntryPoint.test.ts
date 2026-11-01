import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeCommand, handlers } = vi.hoisted(() => ({
  executeCommand: vi.fn(() => Promise.resolve()),
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
}));

vi.mock('vscode', async () => ({
  commands: {
    executeCommand,
    registerCommand: (command: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.set(command, handler);
      return { dispose: () => undefined };
    },
  },
  Uri: (await import('../../test/vscodeMock')).Uri,
  Disposable: class { constructor(readonly dispose: () => void) {} },
}));

import { Uri } from '../../test/vscodeMock';
import { registerBuildEntryPoint } from '../buildEntryPoint';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

beforeEach(() => { vi.clearAllMocks(); handlers.clear(); });

const SOURCE_DIRS = new Map([['ModA', '/instance/source/ModA'], ['ModB', '/instance/source/ModB']]);

function registered() {
  const reporter = recordingReporter();
  const value = instanceValueFixture({
    paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs: SOURCE_DIRS },
  });
  registerBuildEntryPoint({ instance: { value, subscribe: () => ({ dispose: () => undefined }) }, reporter });
  return { entry: present(handlers.get('modbench.source.build'), 'the entry point'), reporter };
}

const carrying = (...names: string[]) => names.map((name) => ({ argument: { kind: 'mod', name } }));

describe('the build entry point (source.md, Menus and keys)', () => {
  it('tells the menus which resources are a source mod\'s folder or build file', () => {
    registered();

    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.source.buildTargets', [
      'file:///instance/source/ModA', 'file:///instance/source/ModA/build.json',
      'file:///instance/source/ModB', 'file:///instance/source/ModB/build.json',
    ]);
  });

  it('fires build with the mods the folders and build files stand for, each once', async () => {
    const { entry } = registered();
    const folderA = Uri.file('/instance/source/ModA');
    const fileA = Uri.file('/instance/source/ModA/build.json');
    const folderB = Uri.file('/instance/source/ModB');

    await entry(folderA, [folderA, fileA, folderB]);

    expect(executeCommand).toHaveBeenLastCalledWith('modbench.mod.build', carrying('ModA')[0], carrying('ModA', 'ModB'));
  });

  it('fires build for the one resource a run button names', async () => {
    const { entry } = registered();

    await entry(Uri.file('/instance/source/ModB/build.json'));

    expect(executeCommand).toHaveBeenLastCalledWith('modbench.mod.build', carrying('ModB')[0], carrying('ModB'));
  });

  it('refuses a resource that is no source mod\'s, by name, and builds nothing', async () => {
    const { entry, reporter } = registered();
    executeCommand.mockClear();

    await entry(Uri.file('/elsewhere/build.json'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build "/elsewhere/build.json".', detail: 'It is not a source mod\'s source folder or build file.' },
    ]);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
