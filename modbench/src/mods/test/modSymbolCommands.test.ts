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

import { registerGoToModRowCommand, registerModReferencedByCommand } from '../modSymbolCommands';
import { ModNode } from '../ModListProvider';
import { present } from '../../ports/present';
import { recordingReporter } from '../../test/surfacingDoubles';

const aRow = new ModNode({ kind: 'mod', name: 'Base Mod', enabled: true });
const asked = { argument: { kind: 'mod', name: 'Base Mod' } };

describe('the mod go to command (commands.md, `go to` under Mod)', () => {
  beforeEach(() => { handlers.clear(); executeCommand.mockClear(); });

  function setup(shown: { row?: ModNode; folder?: string }, selection: readonly ModNode[] = []) {
    const reveal = vi.fn((_row: ModNode) => Promise.resolve());
    const reporter = recordingReporter();
    registerGoToModRowCommand({ rowOf: () => shown.row, folderOf: () => shown.folder, reveal, reporter }, () => selection);
    return { reveal, reporter, run: present(handlers.get('modbench.mod.goTo'), 'the go to command') };
  }

  it('selects the mod\'s row in Mods', async () => {
    const { reveal, run, reporter } = setup({ row: aRow, folder: '/mods/Base Mod' });

    await run(asked);

    expect([reveal.mock.calls, executeCommand.mock.calls, reporter.reports]).toEqual([[[aRow]], [], []]);
  });

  it('takes the one selected row from the palette', async () => {
    const { reveal, run } = setup({ row: aRow }, [aRow]);

    await run();

    expect(reveal.mock.calls).toEqual([[aRow]]);
  });

  it('shows the mod\'s folder in the Explorer when Mods shows no row for it', async () => {
    const { reveal, run } = setup({ folder: '/mods/Base Mod' });

    await run(asked);

    expect([reveal.mock.calls, executeCommand.mock.calls]).toEqual([[], [['revealInExplorer', Uri.file('/mods/Base Mod')]]]);
  });

  it('says why when there is neither a row nor a folder', async () => {
    const { run, reporter } = setup({});

    await run(asked);

    expect(reporter.reports.map(({ severity, message }) => [severity, message])).toEqual([['error', 'Could not go to "Base Mod": Mods shows no row for it and no folder holds it.']]);
  });
});

describe('the mod referenced by command (commands.md, `referenced by` under Mod)', () => {
  beforeEach(() => { handlers.clear(); });

  it('lists the places that name the mod the row stands for', async () => {
    const referencedBy = vi.fn(() => Promise.resolve());
    registerModReferencedByCommand(referencedBy, () => []);

    await present(handlers.get('modbench.mod.referencedBy'), 'the referenced by command')(asked);

    expect(referencedBy.mock.calls).toEqual([['Base Mod']]);
  });

  it('lists nothing for a row that is no mod', async () => {
    const referencedBy = vi.fn(() => Promise.resolve());
    registerModReferencedByCommand(referencedBy, () => []);

    await present(handlers.get('modbench.mod.referencedBy'), 'the referenced by command')({ argument: { kind: 'separator', name: 'Gear' } });

    expect(referencedBy).not.toHaveBeenCalled();
  });
});
