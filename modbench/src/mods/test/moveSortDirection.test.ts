// "As shown" is as the view displays it in its current sort direction (mods.md, Pickers, Move),
// so each case reads the tree built from the file the move wrote, in the direction it was made.

import { describe, it, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, DataTransferItem, DataTransfer, FakeCancellationToken,
} from '../../test/vscodeMock';

const { registerCommand, executeCommand, showQuickPick } = vi.hoisted(() => {
  const registerCommand = vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler }));
  // The command registry: a command fired runs the handler registered last under its id.
  const executeCommand = vi.fn((id: string, ...args: unknown[]) => {
    const registered = registerCommand.mock.calls.findLast((c) => c[0] === id);
    if (!registered) return Promise.reject(new Error(`${id} is not registered`));
    return Promise.resolve(registered[1](...args));
  });
  return { registerCommand, executeCommand, showQuickPick: vi.fn() };
});

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  commands: { registerCommand, executeCommand },
  window: { showQuickPick },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
}));

import { Instance } from '../../instanceLoader/instance';
import { ModListProvider, SeparatorNode, type ModlistNode, type SortDirection } from '../ModListProvider';
import { registerModMoveCommand } from '../modManagementCommands';
import { recordingReporter } from '../../test/surfacingDoubles';
import { resolvesNotFound } from '../../test/mo2/gameFolderNotFound';
import { resolvesNoDownloads } from '../../test/mo2/downloadsUnresolved';

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

function rowsNamed(rows: readonly ModlistNode[], named: readonly RowName[]): ModlistNode[] {
  return named.map((want) => {
    const row = rows.find((r) => r.kind === want.kind && nameOf(r) === want.name);
    if (!row) throw new Error(`no ${want.kind} row named ${want.name}`);
    return row;
  });
}

// `act` works a real tree over the corpus, sorted `direction`, with the move command registered:
// the view, in that direction, once the Instance reads the file back.
async function shownAfter(
  direction: SortDirection, act: (provider: ModListProvider, rows: readonly ModlistNode[]) => Promise<void>,
): Promise<string[]> {
  const root = await cloneCorpusFixture();
  const instance = new Instance({
    instanceRoot: root, log: () => {}, logReadFailure: () => {},
    resolveGameDirectory: resolvesNotFound,
    resolveDownloadsDirectory: resolvesNoDownloads,
  });
  const provider = new ModListProvider({ instance, instanceRoot: root });
  try {
    await instance.refresh();
    provider.setViewDirection(direction);
    registerCommand.mockClear();
    const reporter = recordingReporter();
    registerModMoveCommand(root, instance, { selection: () => [], direction: () => provider.viewDirection() }, reporter);
    await act(provider, (await shownRows(provider)).rows);
    expect(reporter.reports).toEqual([]);
    await instance.refresh();
    return (await shownRows(provider)).labels;
  } finally {
    provider.dispose();
    instance.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

// A right click on the first of `selected`, and the pick answered with `placeLabel`.
const moveFrom = (direction: SortDirection, selected: readonly RowName[], placeLabel: string) =>
  shownAfter(direction, async (_provider, rows) => {
    const selection = rowsNamed(rows, selected);
    showQuickPick.mockImplementationOnce((items: { label: string }[]) =>
      Promise.resolve(items.find((i) => i.label === placeLabel)));
    await executeCommand('modbench.mod.move', selection[0], selection);
  });

const BELOW_THE_LAST_ROW = 'below the last row';

// A drag of `dragged`, in the order VS Code hands them, dropped on `target`.
const dropFrom = (direction: SortDirection, dragged: readonly RowName[], target: RowName | typeof BELOW_THE_LAST_ROW) =>
  shownAfter(direction, async (provider, rows) => {
    const dataTransfer = new DataTransfer();
    const token = new FakeCancellationToken();
    provider.handleDrag(rowsNamed(rows, dragged), dataTransfer, token);
    await provider.handleDrop(target === BELOW_THE_LAST_ROW ? undefined : rowsNamed(rows, [target])[0], dataTransfer, token);
  });

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

const modRow = (name: string): RowName => ({ kind: 'mod', name });
const separatorRow = (name: string): RowName => ({ kind: 'separator', name });
const CRACKED = 'Cracked and Smudged Pip-Boy Screen';
const SKK = 'SKK Fast Start new game (Fallout 4)';
const UFO4P = 'Unofficial Fallout 4 Patch';

describe('a drop lands where the view shows it, in its current sort direction', () => {
  it('losing at the top: mods dropped on a mod land directly above it, in its separator', async () => {
    expect(await dropFrom('losingAtTop', [modRow(CRACKED)], modRow('Tracked Patch Mod'))).toEqual([
      'Harder VATS', 'ENBoost - 12k',
      `▸ ${RADFALL}`, UFO4P, '[NODELETE] Radfall',
      `▸ ${UNASSIGNED}`, SKK, CRACKED, 'Tracked Patch Mod', "Ñoño's Retexture",
      'Overwrite',
    ]);
  });

  it('winning at the top: mods dropped on a mod land directly above it, in its separator', async () => {
    expect(await dropFrom('winningAtTop', [modRow(CRACKED)], modRow('Tracked Patch Mod'))).toEqual([
      'Overwrite',
      `▸ ${UNASSIGNED}`, "Ñoño's Retexture", CRACKED, 'Tracked Patch Mod', SKK,
      `▸ ${RADFALL}`, '[NODELETE] Radfall', UFO4P,
      'ENBoost - 12k', 'Harder VATS',
    ]);
  });

  const twoGrouped = [modRow(UFO4P), modRow(SKK)];

  it('losing at the top: mods dropped on an ungrouped mod land directly above it, ungrouped, in the order they showed', async () => {
    expect(await dropFrom('losingAtTop', twoGrouped, modRow('ENBoost - 12k'))).toEqual([
      CRACKED, 'Harder VATS', UFO4P, SKK, 'ENBoost - 12k',
      `▸ ${RADFALL}`, '[NODELETE] Radfall',
      `▸ ${UNASSIGNED}`, 'Tracked Patch Mod', "Ñoño's Retexture",
      'Overwrite',
    ]);
  });

  it('winning at the top: mods dropped on an ungrouped mod land directly above it, ungrouped, in the order they showed', async () => {
    expect(await dropFrom('winningAtTop', twoGrouped, modRow('ENBoost - 12k'))).toEqual([
      'Overwrite',
      `▸ ${UNASSIGNED}`, "Ñoño's Retexture", 'Tracked Patch Mod',
      `▸ ${RADFALL}`, '[NODELETE] Radfall',
      SKK, UFO4P, 'ENBoost - 12k', 'Harder VATS', CRACKED,
    ]);
  });

  it('losing at the top: mods dropped on a separator become its first mods', async () => {
    expect(await dropFrom('losingAtTop', [modRow('Harder VATS')], separatorRow(RADFALL))).toEqual([
      CRACKED, 'ENBoost - 12k',
      `▸ ${RADFALL}`, 'Harder VATS', UFO4P, '[NODELETE] Radfall',
      `▸ ${UNASSIGNED}`, SKK, 'Tracked Patch Mod', "Ñoño's Retexture",
      'Overwrite',
    ]);
  });

  it('winning at the top: mods dropped on a separator become its first mods', async () => {
    expect(await dropFrom('winningAtTop', [modRow('Harder VATS')], separatorRow(RADFALL))).toEqual([
      'Overwrite',
      `▸ ${UNASSIGNED}`, "Ñoño's Retexture", 'Tracked Patch Mod', SKK,
      `▸ ${RADFALL}`, 'Harder VATS', '[NODELETE] Radfall', UFO4P,
      'ENBoost - 12k', CRACKED,
    ]);
  });

  it('losing at the top: a separator dropped on a separator lands directly above it, and the target keeps its mods', async () => {
    expect(await dropFrom('losingAtTop', [separatorRow(UNASSIGNED)], separatorRow(RADFALL))).toEqual([
      CRACKED, 'Harder VATS', 'ENBoost - 12k',
      `▸ ${UNASSIGNED}`, SKK, 'Tracked Patch Mod', "Ñoño's Retexture",
      `▸ ${RADFALL}`, UFO4P, '[NODELETE] Radfall',
      'Overwrite',
    ]);
  });

  it('winning at the top: a separator dropped on a separator lands directly above it, and the target keeps its mods', async () => {
    expect(await dropFrom('winningAtTop', [separatorRow(RADFALL)], separatorRow(UNASSIGNED))).toEqual([
      'Overwrite',
      `▸ ${RADFALL}`, '[NODELETE] Radfall', UFO4P,
      `▸ ${UNASSIGNED}`, "Ñoño's Retexture", 'Tracked Patch Mod', SKK,
      'ENBoost - 12k', 'Harder VATS', CRACKED,
    ]);
  });

  it('losing at the top: mods dropped below the last row land at the bottom, above Overwrite', async () => {
    expect(await dropFrom('losingAtTop', [modRow(CRACKED)], BELOW_THE_LAST_ROW)).toEqual([
      'Harder VATS', 'ENBoost - 12k',
      `▸ ${RADFALL}`, UFO4P, '[NODELETE] Radfall',
      `▸ ${UNASSIGNED}`, SKK, 'Tracked Patch Mod', "Ñoño's Retexture", CRACKED,
      'Overwrite',
    ]);
  });

  it('winning at the top: mods dropped below the last row land at the bottom', async () => {
    expect(await dropFrom('winningAtTop', [modRow("Ñoño's Retexture")], BELOW_THE_LAST_ROW)).toEqual([
      'Overwrite',
      `▸ ${UNASSIGNED}`, 'Tracked Patch Mod', SKK,
      `▸ ${RADFALL}`, '[NODELETE] Radfall', UFO4P,
      'ENBoost - 12k', 'Harder VATS', CRACKED, "Ñoño's Retexture",
    ]);
  });

  it('losing at the top: a separator dropped below the last row lands at the bottom, above Overwrite', async () => {
    expect(await dropFrom('losingAtTop', [separatorRow(RADFALL)], BELOW_THE_LAST_ROW)).toEqual([
      CRACKED, 'Harder VATS', 'ENBoost - 12k',
      `▸ ${UNASSIGNED}`, SKK, 'Tracked Patch Mod', "Ñoño's Retexture",
      `▸ ${RADFALL}`, UFO4P, '[NODELETE] Radfall',
      'Overwrite',
    ]);
  });

  it('winning at the top: a separator dropped below the last row lands below every separator, and does not take the ungrouped mods', async () => {
    expect(await dropFrom('winningAtTop', [separatorRow(UNASSIGNED)], BELOW_THE_LAST_ROW)).toEqual([
      'Overwrite',
      `▸ ${RADFALL}`, '[NODELETE] Radfall', UFO4P,
      `▸ ${UNASSIGNED}`, "Ñoño's Retexture", 'Tracked Patch Mod', SKK,
      'ENBoost - 12k', 'Harder VATS', CRACKED,
    ]);
  });

  it('a drag holding a separator and one of its own mods, the separator focused, moves that mod once', async () => {
    expect(await dropFrom('losingAtTop', [modRow('Tracked Patch Mod'), separatorRow(UNASSIGNED)], separatorRow(RADFALL))).toEqual([
      CRACKED, 'Harder VATS', 'ENBoost - 12k',
      `▸ ${UNASSIGNED}`, SKK, 'Tracked Patch Mod', "Ñoño's Retexture",
      `▸ ${RADFALL}`, UFO4P, '[NODELETE] Radfall',
      'Overwrite',
    ]);
  });

  it('a mixed drag, a mod focused, moves only the mods', async () => {
    expect(await dropFrom('losingAtTop', [separatorRow(RADFALL), modRow('Harder VATS')], separatorRow(UNASSIGNED))).toEqual([
      CRACKED, 'ENBoost - 12k',
      `▸ ${RADFALL}`, UFO4P, '[NODELETE] Radfall',
      `▸ ${UNASSIGNED}`, 'Harder VATS', SKK, 'Tracked Patch Mod', "Ñoño's Retexture",
      'Overwrite',
    ]);
  });
});
