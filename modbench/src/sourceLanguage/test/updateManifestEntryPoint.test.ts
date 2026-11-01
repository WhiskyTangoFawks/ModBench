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
  Uri: await (async () => {
    const { Uri: base } = await import('../../test/vscodeMock');
    // The real Uri.toString writes a drive letter in lower case.
    return { ...base, file: (path: string) => {
      const uri = base.file(path);
      return Object.assign(uri, { toString: () => Object.getPrototypeOf(uri).toString.call(uri).replace(/^file:\/\/\/?([A-Z]):/, (_, drive: string) => `file://${drive.toLowerCase()}:`) });
    } };
  })(),
  Disposable: class { constructor(readonly dispose: () => void) {} },
}));

import { Uri } from '../../test/vscodeMock';
import { registerUpdateManifestEntryPoint } from '../updateManifestEntryPoint';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

beforeEach(() => { vi.clearAllMocks(); handlers.clear(); });

const SOURCE_DIRS = new Map([['ModA', '/instance/source/ModA'], ['ModB', '/instance/source/ModB']]);

function registered(sourceDirs = SOURCE_DIRS) {
  const reporter = recordingReporter();
  const value = instanceValueFixture({
    paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs },
  });
  registerUpdateManifestEntryPoint({ instance: { value, subscribe: () => ({ dispose: () => undefined }) }, reporter });
  return { entry: present(handlers.get('modbench.source.updateManifest'), 'the entry point'), reporter };
}

const folder = (path: string) => ({ argument: { kind: 'folder', path } });

describe('the update manifest entry point (source.md, Menus and keys)', () => {
  it('tells the menu which folders are a source mod\'s source folder', () => {
    registered();

    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.source.sourceFolders', ['/instance/source/ModA', '/instance/source/ModB']);
  });

  it('fires update manifest with the source folders the manifests lie in, each once', async () => {
    const { entry } = registered();
    const manifestA = Uri.file('/instance/source/ModA/ModA.manifest.json');
    const otherA = Uri.file('/instance/source/ModA/other.manifest.json');
    const manifestB = Uri.file('/instance/source/ModB/ModB.manifest.json');

    await entry(manifestA, [manifestA, otherA, manifestB]);

    expect(executeCommand).toHaveBeenLastCalledWith(
      'modbench.mod.updateManifest', folder('/instance/source/ModA'), [folder('/instance/source/ModA'), folder('/instance/source/ModB')]);
  });

  it('finds the source folder of a manifest whose drive letter differs in case', async () => {
    const { entry } = registered(new Map([['ModA', 'C:/instance/source/ModA']]));

    await entry(Uri.file('c:/instance/source/ModA/ModA.manifest.json'));

    expect(executeCommand).toHaveBeenLastCalledWith('modbench.mod.updateManifest', folder('C:/instance/source/ModA'), [folder('C:/instance/source/ModA')]);
  });

  it('refuses a manifest outside every source folder, by name, and records nothing', async () => {
    const { entry, reporter } = registered();
    executeCommand.mockClear();

    await entry(Uri.file('/elsewhere/X.manifest.json'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not update the manifest "/elsewhere/X.manifest.json".', detail: 'It is not in a source mod\'s source folder.' },
    ]);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
