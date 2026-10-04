import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, uriFile, uriFrom } from '../../test/vscodeMock';

const { registerCommand, executeCommand } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile, from: uriFrom },
}));

import { registerCompareFileCommand } from '../compareFile';
import { ModNode } from '../ModListProvider';
import { FileNode } from '../modFiles';
import { modOrigin } from '../../instanceLoader/fileConflictIndex';
import type { OriginFile } from '../../instanceLoader/instance';
import { recordingReporter } from '../../test/surfacingDoubles';
import { file, indexedValueOf, mod } from './indexedValue';

const PATH = 'textures/a.dds';

async function setup(overwrite = false) {
  const value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low'), mod('Alone')], {
    High: { files: [file('High', PATH)] },
    Middle: { files: [file('Middle', PATH)] },
    Low: { files: [file('Low', PATH), file('Low', 'b.dds')] },
    Alone: { files: [file('Alone', 'c.dds')] },
  }, overwrite ? { files: [file('overwrite', PATH)] } : undefined);
  const reporter = recordingReporter();
  let selection: FileNode[] = [];
  registerCompareFileCommand({ value }, reporter, () => selection);
  const invoke = (...args: unknown[]) => Promise.resolve(registerCommand.mock.calls.find((c) => c[0] === 'modbench.mod.compareFile')?.[1](...args));
  const cell = (modName: string, path = PATH) => ({ webviewSection: 'conflictCell', origin: { kind: 'mod', name: modName }, path, preventDefaultContextMenuItems: true });
  const row = (modName: string, listed: OriginFile) => {
    const node = new FileNode(new ModNode({ kind: 'mod', name: modName, enabled: true }), modOrigin(modName), listed, 'a.dds', true);
    selection = [node];
    return node;
  };
  const paths = (uri: unknown) => (uri instanceof Object && 'fsPath' in uri ? uri.fsPath : undefined);
  const diffs = () => executeCommand.mock.calls.filter(([id]) => id === 'vscode.diff')
    .map(([, left, right, title]) => [paths(left), paths(right), title]);
  return { invoke, cell, row, diffs, reporter };
}

describe('the compare file command', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the diff editor on a cell\'s copy and the winning copy, titled with the file and both mods', async () => {
    const { invoke, cell, diffs } = await setup();

    await invoke(cell('Low'));

    expect(diffs()).toEqual([[
      '/instance/Low/textures/a.dds', '/instance/High/textures/a.dds',
      'textures/a.dds: Low ↔ High',
    ]]);
  });

  it('compares with Overwrite\'s copy when Overwrite wins', async () => {
    const { invoke, cell, diffs } = await setup(true);

    await invoke(cell('Middle'));

    expect(diffs()).toEqual([[
      '/instance/Middle/textures/a.dds', '/instance/overwrite/textures/a.dds',
      'textures/a.dds: Middle ↔ Overwrite',
    ]]);
  });

  it('takes the Mods file row\'s copy as it takes a cell\'s', async () => {
    const { invoke, row, diffs } = await setup();

    await invoke(row('Middle', file('Middle', PATH)));

    expect(diffs()).toEqual([['/instance/Middle/textures/a.dds', '/instance/High/textures/a.dds', 'textures/a.dds: Middle ↔ High']]);
  });

  it('refuses the winning copy, saying so', async () => {
    const { invoke, cell, diffs, reporter } = await setup();

    await invoke(cell('High'));

    expect(diffs()).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to compare "textures/a.dds".', detail: '"High" holds the winning copy.' }]);
  });

  it('refuses a mod with no copy of the file, or a file no other copy shares', async () => {
    const { invoke, cell, diffs, reporter } = await setup();

    await invoke(cell('Alone'));
    await invoke(cell('Low', 'b.dds'));

    expect(diffs()).toEqual([]);
    expect(reporter.reports.map(({ detail }) => detail)).toEqual(['"Alone" has no copy of it.', '"Low" holds the winning copy.']);
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
