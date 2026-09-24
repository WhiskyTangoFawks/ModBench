// Placement is defined in mod order, never the view's sort direction (CONTEXT.md, Sort
// direction), and "as shown" names the placement with losing at the top.

import { describe, it, expect, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../../test/mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, DataTransferItem, DataTransfer,
} from '../../test/vscodeMock';

const { registerCommand, showQuickPick } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showQuickPick: vi.fn(),
}));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  commands: { registerCommand },
  window: { showQuickPick },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
}));

import { Instance } from '../../instanceLoader/instance';
import { ModListProvider, SeparatorNode, type ModlistNode, type SortDirection } from '../ModListProvider';
import { registerModMoveCommand } from '../modManagementCommands';
import { recordingReporter } from '../../test/surfacingDoubles';
import { parseModlist } from '../../mo2Codecs/modlistText';

type RowName = { kind: 'mod' | 'separator'; name: string };

const nameOf = (row: ModlistNode): string | undefined =>
  row.kind === 'mod' ? row.mod.name : row.kind === 'separator' ? row.separator.name : undefined;

async function everyRow(provider: ModListProvider): Promise<ModlistNode[]> {
  const roots = await provider.getChildren();
  const children = await Promise.all(roots.filter((r) => r instanceof SeparatorNode).map((r) => provider.getChildren(r)));
  return [...roots, ...children.flat()];
}

// A right click on the first of `selected`, in a real tree sorted `direction`, and the pick
// answered with `placeLabel`: the bytes the move leaves in modlist.txt.
async function moveFrom(direction: SortDirection, selected: readonly RowName[], placeLabel: string): Promise<string> {
  const root = await cloneCorpusFixture();
  const instance = new Instance({
    instanceRoot: root, log: () => {}, logReadFailure: () => {},
    resolveGameDirectory: () => Promise.resolve(undefined),
  });
  try {
    await instance.refresh();
    const provider = new ModListProvider({ instance, instanceRoot: root });
    provider.setViewDirection(direction);
    const rows = await everyRow(provider);
    const selection = selected.map((want) => {
      const row = rows.find((r) => r.kind === want.kind && nameOf(r) === want.name);
      if (!row) throw new Error(`no ${want.kind} row named ${want.name}`);
      return row;
    });
    registerCommand.mockClear();
    showQuickPick.mockImplementationOnce((items: { label: string }[]) =>
      Promise.resolve(items.find((i) => i.label === placeLabel)));
    const reporter = recordingReporter();
    registerModMoveCommand(root, instance, { selection: () => [], direction: () => provider.viewDirection() }, reporter);
    const call = registerCommand.mock.calls.find((c) => c[0] === 'modbench.mod.move');
    if (!call) throw new Error('modbench.mod.move not registered');
    await call[1](selection[0], selection);
    expect(reporter.reports).toEqual([]);
    provider.dispose();
    return await readFile(`${root}/${DEFAULT_MODLIST}`, 'utf8');
  } finally {
    instance.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

const entryNames = (text: string): string[] => parseModlist(text).map((e) => e.name);

describe('move writes the same bytes whichever way the view is sorted', () => {
  it('mods become the chosen separator\'s first mods as shown, keeping their order', async () => {
    const selected: RowName[] = [
      { kind: 'mod', name: 'Cracked and Smudged Pip-Boy Screen' }, { kind: 'mod', name: 'ENBoost - 12k' },
    ];

    const fromLosing = await moveFrom('losingAtTop', selected, 'Unassigned (Modlist Development)');
    const fromWinning = await moveFrom('winningAtTop', selected, 'Unassigned (Modlist Development)');

    expect(fromWinning).toBe(fromLosing);
    expect(entryNames(fromLosing)).toEqual([
      "Ñoño's Retexture",
      'Tracked Patch Mod',
      'SKK Fast Start new game (Fallout 4)',
      'ENBoost - 12k',
      'Cracked and Smudged Pip-Boy Screen',
      'Unassigned (Modlist Development)',
      '[NODELETE] Radfall',
      'Unofficial Fallout 4 Patch',
      'Radfall - All-In-One Survival Overhaul',
      'Harder VATS',
    ]);
  });

  it('Ungrouped places the mods first among the ungrouped mods as shown, keeping their order', async () => {
    const selected: RowName[] = [
      { kind: 'mod', name: '[NODELETE] Radfall' }, { kind: 'mod', name: 'SKK Fast Start new game (Fallout 4)' },
    ];

    const fromLosing = await moveFrom('losingAtTop', selected, 'Ungrouped');
    const fromWinning = await moveFrom('winningAtTop', selected, 'Ungrouped');

    expect(fromWinning).toBe(fromLosing);
    expect(entryNames(fromLosing)).toEqual([
      "Ñoño's Retexture",
      'Tracked Patch Mod',
      'Unassigned (Modlist Development)',
      'Unofficial Fallout 4 Patch',
      'Radfall - All-In-One Survival Overhaul',
      'ENBoost - 12k',
      'Harder VATS',
      'Cracked and Smudged Pip-Boy Screen',
      'SKK Fast Start new game (Fallout 4)',
      '[NODELETE] Radfall',
    ]);
  });

  it('a separator lands with its mods directly above the chosen one as shown, moving a selected mod of its own once', async () => {
    const selected: RowName[] = [
      { kind: 'separator', name: 'Unassigned (Modlist Development)' },
      { kind: 'mod', name: 'Tracked Patch Mod' },
    ];

    const fromLosing = await moveFrom('losingAtTop', selected, 'Radfall - All-In-One Survival Overhaul');
    const fromWinning = await moveFrom('winningAtTop', selected, 'Radfall - All-In-One Survival Overhaul');

    expect(fromWinning).toBe(fromLosing);
    expect(entryNames(fromLosing)).toEqual([
      '[NODELETE] Radfall',
      'Unofficial Fallout 4 Patch',
      'Radfall - All-In-One Survival Overhaul',
      "Ñoño's Retexture",
      'Tracked Patch Mod',
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
      'ENBoost - 12k',
      'Harder VATS',
      'Cracked and Smudged Pip-Boy Screen',
    ]);
  });
});
