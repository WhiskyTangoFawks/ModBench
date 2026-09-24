// "As shown" is as the view displays it in its current sort direction (mods.md, Pickers, Move),
// so each case reads the tree built from the file the move wrote, in the direction it was made.

import { describe, it, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
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
import { resolvesNotFound } from '../../test/mo2/gameFolderNotFound';
import { downloadsDirectoryResolver } from '../../instanceAdapter/downloadsDirectory';

type RowName = { kind: 'mod' | 'separator'; name: string };

const nameOf = (row: ModlistNode): string | undefined =>
  row.kind === 'mod' ? row.mod.name : row.kind === 'separator' ? row.separator.name : undefined;

// The view top to bottom, every separator expanded: a separator row reads `▸ name`.
async function shownRows(provider: ModListProvider): Promise<{ rows: ModlistNode[]; labels: string[] }> {
  const rows: ModlistNode[] = [];
  for (const root of await provider.getChildren()) {
    rows.push(root);
    if (root instanceof SeparatorNode) rows.push(...await provider.getChildren(root));
  }
  const labels = rows.map((row) => (row.kind === 'separator' ? `▸ ${row.separator.name}` : nameOf(row) ?? 'Overwrite'));
  return { rows, labels };
}

// A right click on the first of `selected`, in a real tree sorted `direction`, and the pick
// answered with `placeLabel`: the view, in that direction, once the Instance reads the file back.
async function moveFrom(direction: SortDirection, selected: readonly RowName[], placeLabel: string): Promise<string[]> {
  const root = await cloneCorpusFixture();
  const instance = new Instance({
    instanceRoot: root, log: () => {}, logReadFailure: () => {},
    resolveGameDirectory: resolvesNotFound,
    resolveDownloadsDirectory: downloadsDirectoryResolver(),
  });
  const provider = new ModListProvider({ instance, instanceRoot: root });
  try {
    await instance.refresh();
    provider.setViewDirection(direction);
    const { rows } = await shownRows(provider);
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
    await instance.refresh();
    return (await shownRows(provider)).labels;
  } finally {
    provider.dispose();
    instance.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

const UNASSIGNED = 'Unassigned (Modlist Development)';
const RADFALL = 'Radfall - All-In-One Survival Overhaul';

describe('move places what it moves as the view shows it, in its current sort direction', () => {
  const twoUngrouped: RowName[] = [
    { kind: 'mod', name: 'Cracked and Smudged Pip-Boy Screen' }, { kind: 'mod', name: 'ENBoost - 12k' },
  ];

  it('losing at the top: the mods become the separator\'s first mods, in the order they showed', async () => {
    expect(await moveFrom('losingAtTop', twoUngrouped, UNASSIGNED)).toEqual([
      'Harder VATS',
      `▸ ${RADFALL}`, 'Unofficial Fallout 4 Patch', '[NODELETE] Radfall',
      `▸ ${UNASSIGNED}`, 'Cracked and Smudged Pip-Boy Screen', 'ENBoost - 12k',
      'SKK Fast Start new game (Fallout 4)', 'Tracked Patch Mod', "Ñoño's Retexture",
      'Overwrite',
    ]);
  });

  it('winning at the top: the mods become the separator\'s first mods, in the order they showed', async () => {
    expect(await moveFrom('winningAtTop', twoUngrouped, UNASSIGNED)).toEqual([
      'Overwrite',
      `▸ ${UNASSIGNED}`, 'ENBoost - 12k', 'Cracked and Smudged Pip-Boy Screen',
      "Ñoño's Retexture", 'Tracked Patch Mod', 'SKK Fast Start new game (Fallout 4)',
      `▸ ${RADFALL}`, '[NODELETE] Radfall', 'Unofficial Fallout 4 Patch',
      'Harder VATS',
    ]);
  });

  const twoGrouped: RowName[] = [
    { kind: 'mod', name: '[NODELETE] Radfall' }, { kind: 'mod', name: 'SKK Fast Start new game (Fallout 4)' },
  ];

  it('losing at the top: Ungrouped places the mods first among the ungrouped mods, in the order they showed', async () => {
    expect(await moveFrom('losingAtTop', twoGrouped, 'Ungrouped')).toEqual([
      '[NODELETE] Radfall', 'SKK Fast Start new game (Fallout 4)',
      'Cracked and Smudged Pip-Boy Screen', 'Harder VATS', 'ENBoost - 12k',
      `▸ ${RADFALL}`, 'Unofficial Fallout 4 Patch',
      `▸ ${UNASSIGNED}`, 'Tracked Patch Mod', "Ñoño's Retexture",
      'Overwrite',
    ]);
  });

  it('winning at the top: Ungrouped places the mods first among the ungrouped mods, in the order they showed', async () => {
    expect(await moveFrom('winningAtTop', twoGrouped, 'Ungrouped')).toEqual([
      'Overwrite',
      `▸ ${UNASSIGNED}`, "Ñoño's Retexture", 'Tracked Patch Mod',
      `▸ ${RADFALL}`, 'Unofficial Fallout 4 Patch',
      'SKK Fast Start new game (Fallout 4)', '[NODELETE] Radfall',
      'ENBoost - 12k', 'Harder VATS', 'Cracked and Smudged Pip-Boy Screen',
    ]);
  });

  it('losing at the top: a separator lands with its mods directly above the chosen one, moving a selected mod of its own once', async () => {
    const selected: RowName[] = [{ kind: 'separator', name: UNASSIGNED }, { kind: 'mod', name: 'Tracked Patch Mod' }];

    expect(await moveFrom('losingAtTop', selected, RADFALL)).toEqual([
      'Cracked and Smudged Pip-Boy Screen', 'Harder VATS', 'ENBoost - 12k',
      `▸ ${UNASSIGNED}`, 'SKK Fast Start new game (Fallout 4)', 'Tracked Patch Mod', "Ñoño's Retexture",
      `▸ ${RADFALL}`, 'Unofficial Fallout 4 Patch', '[NODELETE] Radfall',
      'Overwrite',
    ]);
  });

  it('winning at the top: a separator lands with its mods directly above the chosen one, moving a selected mod of its own once', async () => {
    const selected: RowName[] = [{ kind: 'separator', name: RADFALL }, { kind: 'mod', name: 'Unofficial Fallout 4 Patch' }];

    expect(await moveFrom('winningAtTop', selected, UNASSIGNED)).toEqual([
      'Overwrite',
      `▸ ${RADFALL}`, '[NODELETE] Radfall', 'Unofficial Fallout 4 Patch',
      `▸ ${UNASSIGNED}`, "Ñoño's Retexture", 'Tracked Patch Mod', 'SKK Fast Start new game (Fallout 4)',
      'ENBoost - 12k', 'Harder VATS', 'Cracked and Smudged Pip-Boy Screen',
    ]);
  });
});
