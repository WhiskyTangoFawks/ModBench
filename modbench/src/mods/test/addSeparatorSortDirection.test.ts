// Placement is defined in mod order, never the view's sort direction (mods.md, Sort
// direction). The same anchor, clicked from a tree sorted either way, writes identical bytes.

import { describe, it, expect, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../../test/mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, DataTransferItem, DataTransfer,
} from '../../test/vscodeMock';

const { registerCommand, showInputBox } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showInputBox: vi.fn(),
}));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  commands: { registerCommand },
  window: { showInputBox },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
}));

import { Instance } from '../../instanceLoader/instance';
import { ModListProvider, type ModlistNode, type SortDirection } from '../ModListProvider';
import { registerSeparatorCommands } from '../modManagementCommands';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { resolvesNotFound } from '../../test/mo2/gameFolderNotFound';
import { downloadsDirectoryResolver } from '../../instanceAdapter/downloadsDirectory';

const runModAction = async (_label: string, _fail: string, action: () => Promise<void>) => action();

// The row a real tree, sorted the given way, hands a right click — not a hand-built fixture.
async function anchorRow(direction: SortDirection, isRow: (node: ModlistNode) => boolean): Promise<ModlistNode> {
  const root = await cloneCorpusFixture();
  try {
    const instance = new Instance({
      instanceRoot: root, log: () => {}, logReadFailure: () => {},
      resolveGameDirectory: resolvesNotFound,
      resolveDownloadsDirectory: downloadsDirectoryResolver(),
    });
    await instance.refresh();
    const provider = new ModListProvider({ instance, instanceRoot: root });
    provider.setViewDirection(direction);
    const row = (await provider.getChildren()).find(isRow);
    instance.dispose();
    if (!row) throw new Error('anchor row not found');
    return row;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeWithAnchor(anchor: ModlistNode): Promise<string> {
  const root = await cloneCorpusFixture();
  registerCommand.mockClear();
  showInputBox.mockResolvedValueOnce('New Section');
  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  registerSeparatorCommands(root, instance, runModAction, () => []);
  const call = registerCommand.mock.calls.find((c) => c[0] === 'modbench.separator.add');
  if (!call) throw new Error('modbench.separator.add not registered');
  await call[1](anchor);
  const text = await readFile(`${root}/${DEFAULT_MODLIST}`, 'utf8');
  await rm(root, { recursive: true, force: true });
  return text;
}

describe('add separator writes the same bytes whichever way the view is sorted', () => {
  it('on a mod', async () => {
    const isTheMod = (n: ModlistNode): boolean => n.kind === 'mod' && n.mod.name === 'Cracked and Smudged Pip-Boy Screen';
    const losing = await anchorRow('losingAtTop', isTheMod);
    const winning = await anchorRow('winningAtTop', isTheMod);

    const fromLosing = await writeWithAnchor(losing);
    const fromWinning = await writeWithAnchor(winning);

    expect(fromWinning).toBe(fromLosing);
  });

  it('on a separator', async () => {
    const isTheSeparator = (n: ModlistNode): boolean =>
      n.kind === 'separator' && n.separator.name === 'Radfall - All-In-One Survival Overhaul';
    const losing = await anchorRow('losingAtTop', isTheSeparator);
    const winning = await anchorRow('winningAtTop', isTheSeparator);

    const fromLosing = await writeWithAnchor(losing);
    const fromWinning = await writeWithAnchor(winning);

    expect(fromWinning).toBe(fromLosing);
  });
});
