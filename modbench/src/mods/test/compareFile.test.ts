import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri } from '../../test/vscodeMock';

const { registerCommand, executeCommand, served } = vi.hoisted(() => ({
  served: new Map<string, { readFile(uri: unknown): Promise<Uint8Array> }>(),
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  workspace: { registerFileSystemProvider: (scheme: string, provider: { readFile(uri: unknown): Promise<Uint8Array> }) => { served.set(scheme, provider); return { dispose: () => undefined }; } },
  Disposable: class { constructor(public dispose: () => void) {} },
  FileType: { File: 1, Directory: 2 },
  FileSystemError: { FileNotFound: (what: { path: string }) => new Error(`FileNotFound ${what.path}`) },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri,
}));

import { registerCompareFileCommand } from '../compareFile';
import { ModNode } from '../ModListProvider';
import { FileNode } from '../modFiles';
import { modOrigin } from '../../instanceLoader/fileConflictIndex';
import type { OriginFile } from '../../instanceLoader/instance';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { file, indexedValueOf, mod } from './indexedValue';
import { registerArchiveFiles } from '../archiveFiles';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const PATH = 'textures/a.dds';

const ARCHIVE = '/instance/Alone/Alone.ba2';

async function setup(overwrite = false) {
  const value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low'), mod('Alone')], {
    High: { files: [file('High', PATH)] },
    Middle: { files: [file('Middle', PATH)] },
    Low: { files: [file('Low', PATH), file('Low', 'b.dds')] },
    Alone: { files: [file('Alone', 'c.dds'), file('Alone', 'Alone.ba2')] },
  }, overwrite ? { files: [file('overwrite', PATH)] } : undefined, [{ origin: modOrigin('Alone'), archive: ARCHIVE, files: [PATH] }]);
  const reporter = recordingReporter();
  let selection: FileNode[] = [];
  registerCompareFileCommand({ value }, reporter, () => selection);
  const handler = present(registerCommand.mock.calls.find((c) => c[0] === 'modbench.mod.compareFile'), 'the compare file command')[1];
  const invoke = (...args: unknown[]) => Promise.resolve(handler(...args));
  const cell = (modName: string, path = PATH) => ({ webviewSection: 'conflictCell', origin: { kind: 'mod', name: modName }, path, preventDefaultContextMenuItems: true });
  const row = (modName: string, listed: OriginFile) => {
    const node = new FileNode(new ModNode({ kind: 'mod', name: modName, enabled: true }), modOrigin(modName), listed, 'a.dds', 'wins');
    selection = [node];
    return node;
  };
  const paths = (uri: unknown) => (uri instanceof Object && 'scheme' in uri && 'fsPath' in uri ? `${String(uri.scheme)}:${String(uri.fsPath)}` : undefined);
  const diffs = () => executeCommand.mock.calls.filter(([id]) => id === 'vscode.diff')
    .map(([, left, right, title]) => [paths(left), paths(right), title]);
  return { invoke, cell, row, diffs, reporter };
}

describe('the compare file command', () => {
  beforeEach(() => vi.clearAllMocks());

  type Harness = Awaited<ReturnType<typeof setup>>;

  it.each<[string, boolean, (h: Harness) => unknown, [string, string, string]]>([
    ['a cell\'s copy and the winning copy, titled with the file and both mods', false, (h) => h.cell('Low'),
      ['file:/instance/Low/textures/a.dds', 'file:/instance/High/textures/a.dds', 'textures/a.dds: Low ↔ High']],
    ['a cell\'s copy and Overwrite\'s when Overwrite wins', true, (h) => h.cell('Middle'),
      ['file:/instance/Middle/textures/a.dds', 'file:/instance/overwrite/textures/a.dds', 'textures/a.dds: Middle ↔ Overwrite']],
    ['the Mods file row\'s copy as it takes a cell\'s', false, (h) => h.row('Middle', file('Middle', PATH)),
      ['file:/instance/Middle/textures/a.dds', 'file:/instance/High/textures/a.dds', 'textures/a.dds: Middle ↔ High']],
    ['an archived copy, read from its archive', false, (h) => h.cell('Alone'),
      ['modbench-archive:/Alone.ba2/textures/a.dds', 'file:/instance/High/textures/a.dds', 'textures/a.dds: Alone ↔ High']],
  ])('opens the diff editor on %s', async (_case, overwrite, argument, diff) => {
    const h = await setup(overwrite);

    await h.invoke(argument(h));

    expect(h.diffs()).toEqual([diff]);
  });

  it('opens an archived copy at a URI the archive file system reads from the archive', async () => {
    const h = await setup();
    await h.invoke(h.cell('Alone'));
    const archived = executeCommand.mock.calls.find(([id]) => id === 'vscode.diff')?.[1];
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getArchiveFile', new Uint8Array([1]));
    registerArchiveFiles(client);

    await present(served.get('modbench-archive'), 'the archive file system').readFile(archived);

    expect(client.calls.filter((call) => call.method === 'getArchiveFile').map((call) => call.args)).toEqual([['Fallout4', ARCHIVE, PATH]]);
  });

  it.each([
    ['the winning copy', 'High', PATH, '"High" holds the winning copy.'],
    ['a mod with no copy of the file', 'Alone', 'b.dds', '"Alone" has no copy of it.'],
    ['a file no other copy shares', 'Low', 'b.dds', '"Low" holds the winning copy.'],
  ])('refuses %s, saying so', async (_case, modName, path, detail) => {
    const { invoke, cell, diffs, reporter } = await setup();

    await invoke(cell(modName, path));

    expect(diffs()).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: `Failed to compare "${path}".`, detail }]);
  });

  it('opens nothing with no cell or file row to take', async () => {
    const { invoke, diffs, reporter } = await setup();

    await invoke();
    await invoke({ webviewSection: 'conflictColumn', mod: 'Low' });

    expect(diffs()).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('reports a diff VS Code could not open', async () => {
    const { invoke, cell, reporter } = await setup();
    executeCommand.mockRejectedValueOnce(new Error('no editor'));

    await invoke(cell('Low'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to compare "textures/a.dds".', detail: 'no editor' }]);
  });
});
