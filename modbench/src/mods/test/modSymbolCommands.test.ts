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
import { ModNode, type ModlistNode } from '../ModListProvider';
import { present } from '../../ports/present';
import { recordingReporter } from '../../test/surfacingDoubles';

const aRow = new ModNode({ kind: 'mod', name: 'Base Mod', enabled: true });
const asked = { argument: { kind: 'mod', name: 'Base Mod' } };

describe('the mod go to command (commands.md, `go to` under Mod)', () => {
  beforeEach(() => { handlers.clear(); executeCommand.mockClear(); });

  function setup(selection: readonly ModNode[] = []) {
    const reveal = vi.fn((_row: ModlistNode) => Promise.resolve());
    const asking = vi.fn((_mod: string) => aRow);
    registerGoToModRowCommand({ rowOf: asking, folderOf: () => '/mods/Base Mod', reveal, reporter: recordingReporter() }, () => selection);
    return { reveal, asking, run: present(handlers.get('modbench.mod.goTo'), 'the go to command') };
  }

  it('goes to the mod the clicked row carries, which Mods shows as that row', async () => {
    const { reveal, asking, run } = setup();

    await run(asked);

    expect([asking.mock.calls, reveal.mock.calls, executeCommand.mock.calls]).toEqual([[['Base Mod']], [[aRow]], []]);
  });

  it('takes the one selected row from the palette', async () => {
    const { asking, run } = setup([aRow]);

    await run();

    expect(asking.mock.calls).toEqual([['Base Mod']]);
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
