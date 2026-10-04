import { describe, it, expect, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { CORPUS_FIXTURE, cloneCorpusFixture, DEFAULT_MODLIST } from '../../test/mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, uriFrom, DataTransferItem, DataTransfer,
} from '../../test/vscodeMock';

const { registerCommand, showInputBox } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showInputBox: vi.fn(),
}));

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    ...fakeVscodeModule(),
    commands: { registerCommand },
    window: { showInputBox, withProgress: recordedWithProgress },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
    Uri: { file: uriFile, from: uriFrom }, DataTransferItem, DataTransfer,
  };
});

import { ModListProvider, type ModlistNode } from '../ModListProvider';
import type { SortDirection } from '../../drivingLib/sortDirectionToggle';
import { registerSeparatorCommands } from '../modManagementCommands';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { accessTo, readModlistEntries } from '../../test/mo2/adapterOver';
import { present } from '../../ports/present';

async function anchorRowOfARealTreeOverTheCorpusModlist(direction: SortDirection, isRow: (node: ModlistNode) => boolean): Promise<ModlistNode> {
  const instance = new FakeInstance(instanceValueFixture({ mods: await readModlistEntries(CORPUS_FIXTURE) }));
  const provider = new ModListProvider({ instance });
  provider.setViewDirection(direction);
  const row = (await provider.getChildren()).find(isRow);
  provider.dispose();
  return present(row, 'the anchor row');
}

async function writeWithAnchor(anchor: ModlistNode): Promise<string> {
  const root = cloneCorpusFixture();
  registerCommand.mockClear();
  showInputBox.mockResolvedValueOnce('New Section');
  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }), refresh: () => Promise.resolve() };
  const reporter = recordingReporter();
  registerSeparatorCommands(accessTo(root), instance, reporter, scriptedDialog(), vi.fn(), () => []);
  const call = registerCommand.mock.calls.find((c) => c[0] === 'modbench.separator.add');
  await present(call, 'the modbench.separator.add registration')[1](anchor);
  expect(reporter.reports).toEqual([]);
  const text = await readFile(`${root}/${DEFAULT_MODLIST}`, 'utf8');
  await rm(root, { recursive: true, force: true });
  return text;
}

describe('add separator writes the same bytes whichever way the view is sorted, placement being defined in mod order and not the view\'s sort direction', () => {
  it('on a mod', async () => {
    const isTheMod = (n: ModlistNode): boolean => n.kind === 'mod' && n.mod.name === 'Cracked and Smudged Pip-Boy Screen';
    const losing = await anchorRowOfARealTreeOverTheCorpusModlist('losingAtTop', isTheMod);
    const winning = await anchorRowOfARealTreeOverTheCorpusModlist('winningAtTop', isTheMod);

    const fromLosing = await writeWithAnchor(losing);
    const fromWinning = await writeWithAnchor(winning);

    expect(fromWinning).toBe(fromLosing);
  });

  it('on a separator', async () => {
    const isTheSeparator = (n: ModlistNode): boolean =>
      n.kind === 'separator' && n.separator.name === 'Radfall - All-In-One Survival Overhaul';
    const losing = await anchorRowOfARealTreeOverTheCorpusModlist('losingAtTop', isTheSeparator);
    const winning = await anchorRowOfARealTreeOverTheCorpusModlist('winningAtTop', isTheSeparator);

    const fromLosing = await writeWithAnchor(losing);
    const fromWinning = await writeWithAnchor(winning);

    expect(fromWinning).toBe(fromLosing);
  });
});
