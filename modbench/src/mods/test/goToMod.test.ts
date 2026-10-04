import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, uriFile, uriFrom } from '../../test/vscodeMock';

const { registerCommand, showQuickPick } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showQuickPick: vi.fn<(items: readonly { label: string }[]) => Promise<unknown>>(),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showQuickPick },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile, from: uriFrom },
}));

import { registerGoToModCommand } from '../goToMod';
import { ModNode, OverwriteNode } from '../ModListProvider';
import { FileNode, goToModCandidates } from '../modFiles';
import { FileConflictLookup, RUNTIME_OUTPUT, modOrigin, type ConflictEntry } from '../../instanceLoader/fileConflictIndex';
import type { FileOrigin, OriginFile } from '../../instanceLoader/instance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { recordingReporter } from '../../test/surfacingDoubles';

const PATH = 'textures/a.dds';
const entryOf = (...providers: FileOrigin[]): ConflictEntry => ({
  relativePath: PATH, winner: '/w', winnerOrigin: providers[0] ?? RUNTIME_OUTPUT, providers,
});
const high = modOrigin('High');
const middle = modOrigin('Middle');
const low = modOrigin('Low');

describe('the origins go to mod can name for a copy of a file', () => {
  it('is the winning copy for a copy that loses', () => {
    expect(goToModCandidates(entryOf(high, middle, low), middle)).toEqual([high]);
  });

  it('is every copy the winning copy wins over, in the order the index lists them', () => {
    expect(goToModCandidates(entryOf(high, middle, low), high)).toEqual([middle, low]);
  });

  it('is Overwrite as the winner of a mod copy it wins over', () => {
    expect(goToModCandidates(entryOf(RUNTIME_OUTPUT, low), low)).toEqual([RUNTIME_OUTPUT]);
  });

  it('is nothing for a copy nothing else provides, a copy that is no provider, and a path no one provides', () => {
    expect(goToModCandidates(entryOf(high), high)).toEqual([]);
    expect(goToModCandidates(entryOf(high, middle), low)).toEqual([]);
    expect(goToModCandidates(undefined, high)).toEqual([]);
  });

  it('tells a mod folder named overwrite from Overwrite', () => {
    const folderNamedOverwrite = modOrigin('overwrite');
    expect(goToModCandidates(entryOf(RUNTIME_OUTPUT, folderNamedOverwrite), folderNamedOverwrite)).toEqual([RUNTIME_OUTPUT]);
  });
});

describe('the go to mod command', () => {
  beforeEach(() => vi.clearAllMocks());

  const copy: OriginFile = { relativePath: PATH, path: '/m/a.dds', sourcePath: '/m/a.dds', excluded: false };
  const modRows = new Map(['High', 'Middle', 'Low'].map((name) => [name, new ModNode({ kind: 'mod', name, enabled: true })]));
  const overwriteRow = new OverwriteNode([], 'MO2');
  const rowOf = (origin: FileOrigin) => (origin.kind === 'mod' ? modRows.get(origin.name) : overwriteRow);

  function setup(providers: FileOrigin[], rowFor: (origin: FileOrigin) => ModNode | OverwriteNode | undefined = rowOf) {
    const files = new FileConflictLookup();
    files.set(entryOf(...providers));
    const reveal = vi.fn((_row: unknown) => Promise.resolve());
    const reporter = recordingReporter();
    let selection: FileNode[] = [];
    registerGoToModCommand({ value: instanceValueFixture({ files }) }, reporter, { selection: () => selection, rowFor, reveal });
    const fileIn = (origin: FileOrigin) => {
      const parent = rowOf(origin) ?? overwriteRow;
      const row = new FileNode(parent, origin, copy, 'a.dds');
      selection = [row];
      return row;
    };
    const invoke = (...args: unknown[]) => Promise.resolve(registerCommand.mock.calls.find((c) => c[0] === 'modbench.mod.goToMod')?.[1](...args));
    return { reveal, reporter, fileIn, invoke };
  }

  it('selects the winner of a copy that loses, with no pick', async () => {
    const { reveal, fileIn, invoke } = setup([high, middle, low]);

    await invoke(fileIn(middle));

    expect(reveal.mock.calls).toEqual([[modRows.get('High')]]);
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('selects the Overwrite row for a copy Overwrite wins', async () => {
    const { reveal, fileIn, invoke } = setup([RUNTIME_OUTPUT, low]);

    await invoke(fileIn(low));

    expect(reveal.mock.calls).toEqual([[overwriteRow]]);
  });

  it('selects the one mod the winning copy wins over, with no pick', async () => {
    const { reveal, fileIn, invoke } = setup([high, low]);

    await invoke(fileIn(high));

    expect(reveal.mock.calls).toEqual([[modRows.get('Low')]]);
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('picks among the several the winning copy wins over, in the order listed, and selects the pick', async () => {
    const { reveal, fileIn, invoke } = setup([high, middle, low]);
    showQuickPick.mockImplementation((items) => Promise.resolve(items[1]));

    await invoke(fileIn(high));

    expect(showQuickPick.mock.calls[0]?.[0].map((item) => item.label)).toEqual(['Middle', 'Low']);
    expect(reveal.mock.calls).toEqual([[modRows.get('Low')]]);
  });

  it('selects nothing when the pick is dismissed', async () => {
    const { reveal, reporter, fileIn, invoke } = setup([high, middle, low]);
    showQuickPick.mockResolvedValue(undefined);

    await invoke(fileIn(high));

    expect(reveal).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('takes the other mod as its option, with no pick', async () => {
    const { reveal, fileIn, invoke } = setup([high, middle, low]);

    await invoke(fileIn(high), undefined, low);

    expect(reveal.mock.calls).toEqual([[modRows.get('Low')]]);
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('does nothing for a copy no conflict holds, and for a row that is not a file', async () => {
    const { reveal, fileIn, invoke } = setup([high]);

    await invoke(fileIn(high));
    await invoke(modRows.get('High'));

    expect(reveal).not.toHaveBeenCalled();
  });

  it('says so when no row shows the mod, rather than selecting nothing in silence', async () => {
    const { reveal, reporter, fileIn, invoke } = setup([high, low], () => undefined);

    await invoke(fileIn(high));

    expect(reveal).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to go to "Low".', detail: 'No row shows it.' }]);
  });

  it('reports a reveal that fails', async () => {
    const { reveal, reporter, fileIn, invoke } = setup([high, low]);
    reveal.mockRejectedValueOnce(new Error('no such row'));

    await invoke(fileIn(high));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to go to "Low".', detail: 'no such row' }]);
  });

  it('acts on the one selected file when a key hands it no row', async () => {
    const { reveal, fileIn, invoke } = setup([high, low]);
    fileIn(high);

    await invoke();

    expect(reveal.mock.calls).toEqual([[modRows.get('Low')]]);
  });
});
