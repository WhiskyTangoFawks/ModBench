import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter, Uri } from '../../test/vscodeMock';

const { handlers, executeCommand } = vi.hoisted(() => ({
  handlers: new Map<string, (clicked?: unknown) => Promise<void>>(),
  executeCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (command: string, handler: (clicked?: unknown) => Promise<void>) => { handlers.set(command, handler); return { dispose: vi.fn() }; },
    executeCommand,
  },
  Uri,
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter,
}));

import { registerGoToCommand } from '../goToPlugin';
import { PluginNode, type PluginListNode } from '../pluginRows';
import { present } from '../../ports/present';
import { recordingReporter } from '../../test/surfacingDoubles';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const aRow = new PluginNode({ name: BASE.name, enabled: true }, BASE.origin);
const asked = { argument: { kind: 'plugin', plugin: BASE } };

function setup(shown: { row?: PluginNode; file?: string }) {
  const reveal = vi.fn((_row: PluginListNode) => Promise.resolve());
  const reporter = recordingReporter();
  registerGoToCommand({ rowOf: () => shown.row, fileOf: () => shown.file, reveal, reporter }, () => []);
  const run = present(handlers.get('modbench.plugin.goTo'), 'the go to command');
  return { reveal, reporter, run };
}

describe('the plugin go to command (commands.md, `go to` under Plugin)', () => {
  beforeEach(() => { handlers.clear(); executeCommand.mockClear(); });

  it('selects the plugin\'s row in Plugins', async () => {
    const { reveal, run, reporter } = setup({ row: aRow, file: '/data/Base.esm' });

    await run(asked);

    expect([reveal.mock.calls, executeCommand.mock.calls, reporter.reports]).toEqual([[[aRow]], [], []]);
  });

  it('shows the plugin\'s file in the Explorer when Plugins shows no row for it', async () => {
    const { reveal, run } = setup({ file: '/data/Base.esm' });

    await run(asked);

    expect([reveal.mock.calls, executeCommand.mock.calls]).toEqual([[], [['revealInExplorer', Uri.file('/data/Base.esm')]]]);
  });

  it('says why when there is neither a row nor a file', async () => {
    const { run, reporter } = setup({});

    await run(asked);

    expect(reporter.reports.map(({ severity, message }) => [severity, message])).toEqual([['error', 'Could not go to "Base.esm" (Base Mod): Plugins shows no row for it and no file holds it.']]);
  });
});
