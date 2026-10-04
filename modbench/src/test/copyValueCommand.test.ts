import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from './vscodeMock';
import { copyValueVscode, invokeCommand, nothingToCopy, register, writeText } from '../drivingLib/test/copyValueHarness';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  Uri: { from: uriFrom },
  ...copyValueVscode,
}));

import type { CopyValueAdapter } from '../drivingLib/copyValue';
import { modsCopyValueText } from '../mods/modManagementCommands';
import { MODS_KEY_ARGS } from '../mods/gestureEntry';
import { ModNode, type ModlistNode } from '../mods/ModListProvider';
import { recordingReporter } from './surfacingDoubles';

const isViewArgs = (value: unknown, view: string): boolean =>
  typeof value === 'object' && value !== null && Reflect.get(value, 'view') === view;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerCopyValueCommand with Mods\' real adapter', () => {
  it('copies a right-clicked mod\'s own name through modsCopyValueText, unstubbed', async () => {
    const viewSelection = (): ModlistNode[] => [];
    const modsAdapter: CopyValueAdapter = { text: modsCopyValueText(viewSelection), reporterTag: 'mod.copyValue' };
    const referencedByStub: CopyValueAdapter = { text: () => undefined, reporterTag: 'referencedByTree.copy' };
    await register([modsAdapter, referencedByStub], recordingReporter);
    const clicked = new ModNode({ kind: 'mod', name: 'Alpha', enabled: true });

    await invokeCommand(clicked, [clicked]);

    expect(writeText).toHaveBeenCalledWith('Alpha');
  });

  it('a palette call copies the focused view\'s selection, even with a Mods row selected', async () => {
    const viewSelection = (): ModlistNode[] => [new ModNode({ kind: 'mod', name: 'Alpha', enabled: true })];
    const modsAdapter: CopyValueAdapter = { text: modsCopyValueText(viewSelection), reporterTag: 'mod.copyValue' };
    const referencedBy = vi.fn((clicked: unknown) => (isViewArgs(clicked, 'modbench.referencedByTree') ? 'NPC_ / TestNPC' : undefined));
    await register([modsAdapter, { text: (clicked) => referencedBy(clicked), reporterTag: 'referencedByTree.copy' }], recordingReporter, 'modbench.referencedByTree');

    await invokeCommand();

    expect(writeText).toHaveBeenCalledWith('NPC_ / TestNPC');
  });

  it('a palette call with no view focused copies nothing and says so', async () => {
    const viewSelection = (): ModlistNode[] => [new ModNode({ kind: 'mod', name: 'Alpha', enabled: true })];
    await register([{ text: modsCopyValueText(viewSelection), reporterTag: 'mod.copyValue' }], recordingReporter);

    await invokeCommand();

    expect(writeText).not.toHaveBeenCalled();
    expect(nothingToCopy).toHaveBeenCalledOnce();
  });

  it('the Mods key\'s own args copy the Mods selection, not Referenced By\'s', async () => {
    const viewSelection = (): ModlistNode[] => [new ModNode({ kind: 'mod', name: 'Alpha', enabled: true })];
    const modsAdapter: CopyValueAdapter = { text: modsCopyValueText(viewSelection), reporterTag: 'mod.copyValue' };
    const referencedByStub: CopyValueAdapter = { text: () => 'NPC_ / TestNPC', reporterTag: 'referencedByTree.copy' };
    await register([modsAdapter, referencedByStub], recordingReporter);

    await invokeCommand(MODS_KEY_ARGS);

    expect(writeText).toHaveBeenCalledWith('Alpha');
  });
});
