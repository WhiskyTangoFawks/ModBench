import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type * as vscode from 'vscode';
import { labelOf, modsViewOn } from './modsViewOn';
import { answers, seen, vscodeModule } from './modsVscode';
import { MODS_KEY_ARGS } from '../gestureEntry';
import { progressSteps } from '../../test/recordedProgress';
import { Refusal } from '../../drivingLib/refusal';
import { AgentCall } from '../../drivingLib/agentGesture';
import { scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { modCommands } from '../../modCommands/modCommands';
import type { InstanceReading, ModlistEntry, ModOrderChange, OriginFile } from '../../instanceAdapter/instanceAdapter';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { AskQuestion } from '../../ports/dialog';
import { modOrigin } from '../../instanceLoader/fileConflictIndex';
import { fakeInstanceAdapter, modFoldersOf, readingFixture, refusing, repositoriesOf, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import type { Argument } from '../../wire/argument';
import { isUri, modArgumentOf, separatorArgumentOf } from '../../drivingLib/argument';
import type { InstanceRepositoryCommands } from '../../sourceCommands/instanceRepositoryCommands';
import { file, folder, indexedValueOf, mod } from './indexedValue';

type Row = vscode.TreeItem;
type ModsView = ReturnType<typeof modsViewOn>;

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

interface Over extends Omit<NonNullable<Parameters<typeof modsViewOn>[0]>, 'adapter'> {
  answers?: InstanceAnswers;
  reading?: Partial<InstanceReading>;
  listed?: readonly ModlistEntry[];
}

const namedBy = (row: Row): string | undefined => modArgumentOf(row)?.name ?? separatorArgumentOf(row)?.name ?? labelOf(row);

function viewOver(entries: readonly ModlistEntry[], { answers: answered = {}, reading = {}, listed = entries, value, ...deps }: Over = {}): ModsView {
  const adapter = fakeInstanceAdapter(readingFixture({ mods: [...listed], modFolders: modFoldersOf(...listed), ...reading }), answered);
  const view = modsViewOn({ value: value ?? instanceValueFixture({ mods: [...entries] }), adapter, ...deps });
  const entryRow = async (name: string): Promise<Row> => {
    const top = await view.rows();
    const grouped = await Promise.all(top.filter((row) => separatorArgumentOf(row) !== undefined).map(async (group) => await view.rows(group)));
    return present([...top, ...grouped.flat()].find((row) => namedBy(row) === name), `the "${name}" row`);
  };
  return { ...view, row: async (name, parent) => await (parent === undefined ? entryRow(name) : view.row(name, parent)) };
}

const confirming: AskQuestion = (_message, _options, ...buttons) => Promise.resolve(buttons[0]);

const modOrderChange = (...changes: ModOrderChange[]): AdapterCall => ({ verb: 'changeModOrder', profile: 'Default', changes });
const trashed = (kind: 'mod' | 'separator', name: string): AdapterCall => ({ verb: 'trashEntryFolder', entry: { kind, name } });

const validatorOfThePrompt = (): ((value: string) => unknown) => {
  const options = present(seen.inputBoxes.at(-1), 'the options of the prompt the gesture opened');
  return (value) => options.validateInput?.(value);
};

const typing = (name: string | undefined): void => { answers.inputBox = () => name; };

const revealed = (): (string | undefined)[] =>
  seen.executed.filter(([command]) => command === 'revealInExplorer').map(([, uri]) => (isUri(uri) ? uri.fsPath : undefined));

const nothingOpened = (): void => {
  expect([seen.inputBoxes, seen.createdQuickPicks]).toEqual([[], []]);
};

const SEPARATOR_CLASH = 'A separator with this name already exists';

describe('create empty mod', () => {
  const mods = [mod('Existing Mod')];

  it('Esc creates nothing', async () => {
    const { run, adapter, reporter } = viewOver(mods);

    await run('modbench.mod.createEmpty');

    expect([adapter.calls, reporter.reports]).toEqual([[], []]);
  });

  it('the prompt refuses a name a folder holds, in install\'s own words', async () => {
    const { run } = viewOver(mods);

    await run('modbench.mod.createEmpty');
    const validate = validatorOfThePrompt();

    expect([await validate('existing mod'), await validate('Free Name')]).toEqual([
      'A mod named "existing mod" already exists. Install its next release from Downloads, or uninstall it to install anew.', undefined,
    ]);
  });

  it('creates the folder and its line, and reports nothing when both land', async () => {
    const { run, adapter, reporter } = viewOver(mods);
    typing('New Mod');

    await run('modbench.mod.createEmpty');

    expect(adapter.calls).toEqual([
      { verb: 'createModFolder', mod: 'New Mod' }, modOrderChange({ kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'New Mod' } }),
    ]);
    expect(reporter.reports).toEqual([]);
  });

  it('reports a landed-but-partial line failure as a warning, not a failed create', async () => {
    const { run, reporter } = viewOver(mods, { answers: { refusals: refusing('changeModOrder', 'disk full') } });
    typing('New Mod');

    await run('modbench.mod.createEmpty');

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"New Mod" was created, but its modlist.txt line could not be written.',
      detail: 'disk full',
    }]);
  });

  it('names the file mod order is kept in as the value names it, not MO2\'s modlist.txt over another manager\'s', async () => {
    const another = fakeInstanceAdapter(readingFixture({ mods, modFolders: modFoldersOf(...mods) }), { refusals: refusing('changeModOrder', 'disk full') });
    const names = { manager: 'Another Manager', modOrderFile: 'order.txt', downloadedFileMetadataFile: 'order.metadata' };
    const { run, reporter } = viewOver(mods, { commands: modCommands({ ...another.adapter, names }) });
    typing('New Mod');

    await run('modbench.mod.createEmpty');

    expect(reporter.reports.map((r) => r.message)).toEqual(['"New Mod" was created, but its order.txt line could not be written.']);
  });

  it('reports a folder another tool put in the way after the prompt closed as a failed create', async () => {
    const { run, reporter } = viewOver(mods, { listed: [...mods, mod('New Mod')] });
    typing('New Mod');

    await run('modbench.mod.createEmpty');

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to create "New Mod".', detail: 'The folder "/instance/mods/New Mod" is in the way' }]);
  });
});

describe('uninstall over the selection', () => {
  const mods = [mod('Mod A'), mod('Mod B')];

  it.each<[string, ReadonlySet<string>, string[], string]>([
    ['naming the mod', new Set(), ['Mod A'], 'Uninstall "Mod A"? Its folder will be moved to the system trash. It loses its place in mod order and its publisher tags.'],
    ['not mentioning the source of a source mod, which stays', new Set(['Mod A']), ['Mod A'], 'Uninstall "Mod A"? Its folder will be moved to the system trash. It loses its place in mod order and its publisher tags.'],
    ['listing every mod of a selection of several', new Set(), ['Mod A', 'Mod B'], 'Uninstall "Mod A", "Mod B"? Their folders will be moved to the system trash. Each loses its place in mod order and its publisher tags.'],
  ])('asks one modal %s', async (_case, listedSourceMods, selected, message) => {
    const ask = scriptedDialog(undefined);
    const { run, row } = viewOver(mods, { value: instanceValueFixture({ mods, listedSourceMods }), ask });

    await run('modbench.mod.uninstall', await row('Mod A'), await Promise.all(selected.map(async (name) => await row(name))));

    expect(ask.asked).toEqual([{ message, detail: undefined, buttons: ['Uninstall'] }]);
  });

  it('uninstalls the selection once confirmed: each folder into the trash it was given, then each line', async () => {
    const { run, row, adapter, trash } = viewOver(mods, { ask: confirming });
    const [modA, modB] = [await row('Mod A'), await row('Mod B')];

    await run('modbench.mod.uninstall', modA, [modA, modB]);

    expect(trash.mock.calls).toEqual([['/instance/mods/Mod A'], ['/instance/mods/Mod B']]);
    expect(adapter.calls).toEqual([
      trashed('mod', 'Mod A'), trashed('mod', 'Mod B'),
      modOrderChange({ kind: 'dropMod', mod: 'Mod A' }, { kind: 'dropMod', mod: 'Mod B' }),
    ]);
  });

  it('uninstalls nothing when the modal is dismissed', async () => {
    const { run, row, adapter } = viewOver(mods);

    await run('modbench.mod.uninstall', await row('Mod A'));

    expect(adapter.calls).toEqual([]);
  });

  it.each<[string, InstanceAnswers, string, string]>([
    ['publisher tags could not be removed', { publisherTags: [], refusals: refusing('followModFolders', 'not JSON') },
      '"Mod A" was uninstalled, but its publisher tags could not be removed.', 'not JSON'],
    ['line could not be removed after its folder was trashed', { refusals: refusing('changeModOrder', 'disk full') },
      '"Mod A" was uninstalled, but its modlist.txt line could not be removed.', 'disk full'],
  ])('warns, and reports no failed uninstall, of a mod uninstalled whose %s', async (_case, answered, message, detail) => {
    const { run, row, reporter } = viewOver(mods, { answers: answered, reading: { sourceModFolders: repositoriesOf({ 'Mod A': '/instance/source/Mod A' }) }, ask: confirming });

    await run('modbench.mod.uninstall', await row('Mod A'));

    expect(reporter.reports).toEqual([{ severity: 'warning', message, detail }]);
  });

  it('says nothing extra for a fully landed uninstall with no failed mark', async () => {
    const { run, row, reporter, lines } = viewOver(mods, { ask: confirming });

    await run('modbench.mod.uninstall', await row('Mod A'));

    expect([reporter.reports, lines]).toEqual([[], []]);
  });

  it('a failed mark is one Output line and no notification; the uninstall it rides on stands landed', async () => {
    const installedFromItsFile = { metadata: new Map([['Mod A', { installationFile: { name: 'mod-a.7z' } }]]), refusals: refusing('markDownloadedFile', 'disk full') };
    const { run, row, reporter, lines } = viewOver(mods, { answers: installedFromItsFile, ask: confirming });

    await run('modbench.mod.uninstall', await row('Mod A'));

    expect(reporter.reports).toEqual([]);
    expect(lines).toEqual(['[modList] "Mod A" was uninstalled, but its downloaded file could not be marked uninstalled: disk full']);
  });
});

describe('delete separator: the whole selection of separators, asked once', () => {
  const mods = [separator('Group A'), mod('Mod A'), separator('Group B')];

  it('deletes every selected separator in one write, its folder first into the trash it was given, and says nothing when all land', async () => {
    const { run, row, adapter, trash, reporter } = viewOver(mods, { ask: confirming });
    const [groupA, groupB] = [await row('Group A'), await row('Group B')];

    await run('modbench.separator.delete', groupB, [groupA, groupB]);

    expect(trash.mock.calls).toEqual([['/instance/mods/Group A'], ['/instance/mods/Group B']]);
    expect(adapter.calls).toEqual([
      trashed('separator', 'Group A'), trashed('separator', 'Group B'),
      modOrderChange({ kind: 'dropSeparator', separator: 'Group A' }, { kind: 'dropSeparator', separator: 'Group B' }),
    ]);
    expect(reporter.reports).toEqual([]);
  });

  const winningFirst = [separator('Group A'), mod('Mod A'), separator('Group B'), separator('Group C')];

  it.each<[string, string, string[], string]>([
    ['naming the separator after it that the mods join', 'Group A', ['Group A'], 'Delete separator "Group A"? Its mods stay and join "Group B".'],
    ['saying the mods become ungrouped when no separator follows, though one precedes', 'Group C', ['Group C'], 'Delete separator "Group C"? Its mods stay and become ungrouped.'],
    ['skipping an intermediate separator deleted in the same selection', 'Group A', ['Group A', 'Group B'],
      'Delete separators "Group A", "Group B"? Their mods stay: those of "Group A" join "Group C", those of "Group B" join "Group C".'],
    ['listing each separator with where its mods go', 'Group B', ['Group B', 'Group C'],
      'Delete separators "Group B", "Group C"? Their mods stay: those of "Group B" become ungrouped, those of "Group C" become ungrouped.'],
  ])('asks one modal %s', async (_case, clicked, selected, message) => {
    const ask = scriptedDialog(undefined);
    const { run, row } = viewOver(winningFirst, { ask });

    await run('modbench.separator.delete', await row(clicked), await Promise.all(selected.map(async (name) => await row(name))));

    expect(ask.asked).toEqual([{ message, detail: undefined, buttons: ['Delete'] }]);
  });

  it('a cancelled question writes nothing', async () => {
    const { run, row, adapter } = viewOver(mods);
    const [groupA, groupB] = [await row('Group A'), await row('Group B')];

    await run('modbench.separator.delete', groupA, [groupA, groupB]);

    expect(adapter.calls).toEqual([]);
  });

  it('takes only the separators of a selection mixing mods and separators', async () => {
    const { run, row, adapter } = viewOver(mods, { ask: confirming });
    const groupA = await row('Group A');

    await run('modbench.separator.delete', groupA, [await row('Mod A'), groupA]);

    expect(adapter.calls).toEqual([trashed('separator', 'Group A'), modOrderChange({ kind: 'dropSeparator', separator: 'Group A' })]);
  });

  it('writes nothing and reports nothing for a selection with no separator', async () => {
    const { run, row, view, adapter, reporter } = viewOver(mods, { ask: confirming });
    view.selectRows([await row('Mod A')]);

    await run('modbench.separator.delete');

    expect([adapter.calls, reporter.reports]).toEqual([[], []]);
  });

  it('a post-trash line failure is a warning notification naming the part that failed, not a failed delete', async () => {
    const { run, row, reporter } = viewOver(mods, { answers: { refusals: refusing('changeModOrder', 'disk full') }, ask: confirming });

    await run('modbench.separator.delete', await row('Group A'));

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"Group A" was deleted, but its modlist.txt line could not be removed.',
      detail: 'disk full',
    }]);
  });
});

describe('add separator: one command for a mod anchor and a separator anchor', () => {
  const mods = [mod('Mod A'), separator('Group A'), mod('Other Mod'), separator('Other Group'), separator('Taken Meanwhile')];

  it.each<[string, string, string, { kind: 'mod' | 'separator'; name: string }]>([
    ['mod', 'Mod A', 'Other Mod', { kind: 'mod', name: 'Mod A' }],
    ['separator', 'Group A', 'Other Group', { kind: 'separator', name: 'Group A' }],
  ])('prompts and anchors the new separator on the right-clicked %s, not the selection around it', async (_case, clickedName, otherName, anchor) => {
    const { run, row, view, adapter } = viewOver(mods);
    const [clicked, other] = [await row(clickedName), await row(otherName)];
    view.selectRows([other, clicked]);
    typing('New Section');

    await run('modbench.separator.add', clicked, [other, clicked]);

    expect(seen.inputBoxes.at(-1)).toMatchObject({ prompt: 'Separator name', placeHolder: 'My Group' });
    expect(adapter.calls).toEqual([modOrderChange({ kind: 'addSeparator', separator: 'New Section', anchor })]);
  });

  it('asks the command in the prompt whether the name is free of the other separators', async () => {
    const { run, row } = viewOver(mods);

    await run('modbench.separator.add', await row('Mod A'));
    const validate = validatorOfThePrompt();

    expect([await validate('group a'), await validate('Free Name')]).toEqual([SEPARATOR_CLASH, undefined]);
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    const { run, row, reporter } = viewOver(mods);
    typing('Taken Meanwhile');

    await run('modbench.separator.add', await row('Mod A'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to add separator.', detail: SEPARATOR_CLASH }]);
  });

  it.each([['the prompt is cancelled (Esc)', undefined], ['the name is empty', '']])('adds nothing when %s', async (_case, answer) => {
    const { run, row, adapter } = viewOver(mods);
    typing(answer);

    await run('modbench.separator.add', await row('Mod A'));

    expect(adapter.calls).toEqual([]);
  });
});

describe('a name prompt asks the command nothing of an empty name, so an unreadable mod order shows no error there', () => {
  const mods = [mod('Mod A'), separator('Group A')];

  it.each<[string, string, string]>([
    ['add separator', 'modbench.separator.add', 'Mod A'],
  ])('%s', async (_case, command, clicked) => {
    const { run, row } = viewOver(mods, { answers: { unreadReads: { modOrder: 'modlist.txt is locked' } } });

    await run(command, await row(clicked));
    const validate = validatorOfThePrompt();

    expect([await validate(''), await validate('Named')]).toEqual([undefined, 'modlist.txt is locked']);
  });
});

describe('enable and disable: the whole selection, one write per direction', () => {
  const mods = [mod('Mod A', false), mod('Mod B')];

  it.each([
    ['modbench.mod.enable', 'Mod A', true],
    ['modbench.mod.disable', 'Mod B', false],
  ] as const)('%s applies to every selected mod, whatever its own current state', async (command, clicked, enabled) => {
    const { run, row, adapter } = viewOver(mods);

    await run(command, await row(clicked), [await row('Mod A'), await row('Mod B')]);

    expect(adapter.calls).toEqual([modOrderChange({ kind: 'enable', mod: 'Mod A', enabled }, { kind: 'enable', mod: 'Mod B', enabled })]);
  });

  it('says nothing when the whole selection lands', async () => {
    const { run, row, reporter } = viewOver(mods);

    await run('modbench.mod.enable', await row('Mod A'));

    expect(reporter.reports).toEqual([]);
  });
});

describe('enable and disable, called by the agent', () => {
  const mods = [mod('Mod B', false), mod('Selected Mod', false)];

  it.each([
    ['modbench.mod.enable', true],
    ['modbench.mod.disable', false],
  ])('%s acts on the mods given, never on the selection, and answers the outcome, reporting nothing', async (command, enabled) => {
    const { run, row, view, adapter, reporter } = viewOver(mods);
    view.selectRows([await row('Selected Mod')]);

    const answered = await run(command, new AgentCall([{ kind: 'mod', name: 'Mod B' }, { kind: 'mod', name: 'Gone' }], {}));

    expect(adapter.calls).toEqual([modOrderChange({ kind: 'enable', mod: 'Mod B', enabled })]);
    expect(answered).toEqual({ applied: true, outcome: { landed: ['Mod B'], refused: [{ item: 'Gone', reason: 'Mod not found in modlist: Gone' }] } });
    expect(reporter.reports).toEqual([]);
  });
});

describe('move: the selection of mods or of separators, to a picked place', () => {
  const mods = [mod('Mod A'), separator('Group A'), mod('Mod B'), separator('Group B'), mod('Mod C')];
  const pickLabelled = (label: string): void => { answers.createdQuickPick = (items) => items.find((item) => item.label === label); };
  const shownPick = () => present(seen.createdQuickPicks.at(-1), 'the shown pick');

  it('right-clicked on a mod in a mixed selection, moves only the mods to the picked separator', async () => {
    const { run, row, adapter } = viewOver(mods);
    const modA = await row('Mod A');
    pickLabelled('Group B');

    await run('modbench.mod.move', modA, [modA, await row('Group B'), await row('Mod C')]);

    expect(shownPick().items.map((item) => item.label)).toEqual(['Ungrouped', 'Group B', 'Group A']);
    expect(adapter.calls).toEqual([modOrderChange({ kind: 'moveMods', mods: ['Mod A', 'Mod C'], place: { kind: 'separator', name: 'Group B' }, end: 'winning' })]);
  });

  it('right-clicked on a separator in a mixed selection, moves only the separators above the picked one', async () => {
    const { run, row, adapter } = viewOver(mods);
    const groupB = await row('Group B');
    pickLabelled('Group A');

    await run('modbench.mod.move', groupB, [await row('Mod A'), groupB]);

    expect(shownPick().items.map((item) => item.label)).toEqual(['Group A']);
    expect(adapter.calls).toEqual([modOrderChange({ kind: 'moveSeparators', separators: ['Group B'], place: { kind: 'separator', name: 'Group A' }, end: 'losing' })]);
  });

  it('with winning at the top, lands mods at the winning end and separators above the picked one, as the view shows it', async () => {
    const { run, row, adapter } = viewOver(mods);
    const [modC, groupB] = [await row('Mod C'), await row('Group B')];
    await run('modbench.mod.sortWinningAtTop');
    pickLabelled('Group A');

    await run('modbench.mod.move', modC);
    await run('modbench.mod.move', groupB);

    expect(adapter.calls).toEqual([
      modOrderChange({ kind: 'moveMods', mods: ['Mod C'], place: { kind: 'separator', name: 'Group A' }, end: 'winning' }),
      modOrderChange({ kind: 'moveSeparators', separators: ['Group B'], place: { kind: 'separator', name: 'Group A' }, end: 'winning' }),
    ]);
  });

  it('handed a target, as a drop hands one, moves there without a pick', async () => {
    const { run, row, adapter } = viewOver(mods);
    const [modC, groupB] = [await row('Mod C'), await row('Group B')];

    await run('modbench.mod.move', modC, [modC], { place: { kind: 'mod', name: 'Mod A' }, end: 'winning' });
    await run('modbench.mod.move', groupB, [groupB], { place: { kind: 'modOrder' }, end: 'winning' });

    expect(seen.createdQuickPicks).toEqual([]);
    expect(adapter.calls).toEqual([
      modOrderChange({ kind: 'moveMods', mods: ['Mod C'], place: { kind: 'mod', name: 'Mod A' }, end: 'winning' }),
      modOrderChange({ kind: 'moveSeparators', separators: ['Group B'], place: { kind: 'modOrder' }, end: 'winning' }),
    ]);
  });

  it('opens the mods pick on the place that holds the selected mods', async () => {
    const { run, row } = viewOver(mods);

    await run('modbench.mod.move', await row('Mod C'));

    expect(shownPick().activeItems).toMatchObject([{ label: 'Ungrouped', description: 'current' }]);
  });

  it('with the selected mods in several places, opens on none', async () => {
    const { run, row } = viewOver(mods);
    const modA = await row('Mod A');

    await run('modbench.mod.move', modA, [modA, await row('Mod C')]);

    expect(shownPick().activeItems).toEqual([]);
  });

  it('opens the separators pick on no item', async () => {
    const { run, row } = viewOver(mods);

    await run('modbench.mod.move', await row('Group B'));

    expect(shownPick().activeItems).toEqual([]);
  });

  it('from the palette over a selection mixing mods and separators, moves nothing and says nothing', async () => {
    const { run, row, view, adapter, reporter } = viewOver(mods);
    view.selectRows([await row('Mod A'), await row('Group A')]);

    await run('modbench.mod.move');

    expect(seen.createdQuickPicks).toEqual([]);
    expect([adapter.calls, reporter.reports]).toEqual([[], []]);
  });

  it.each([
    ['mods', 'Mod A'],
    ['separators', 'Group B'],
  ])('Esc at the %s pick moves nothing and says nothing', async (_case, clicked) => {
    const { run, row, adapter, reporter } = viewOver(mods);

    await run('modbench.mod.move', await row(clicked));

    expect(seen.createdQuickPicks).toHaveLength(1);
    expect([adapter.calls, reporter.reports]).toEqual([[], []]);
  });
});

describe('open folder: one command for a mod, the Overwrite row, a file and a folder', () => {
  const myMod = [mod('My Mod')];
  const linked: OriginFile = { ...file('mods/My Mod', 'textures/a.dds'), sourcePath: '/elsewhere/a.dds' };
  const archive = file('mods/My Mod', 'Main.ba2');
  const myModValue = async (): Promise<InstanceValue> => ({
    ...await indexedValueOf(myMod, { 'My Mod': { files: [linked, archive], folders: [folder('mods/My Mod', 'textures')] } }, { files: [] },
      [{ origin: modOrigin('My Mod'), archive: archive.sourcePath, files: ['meshes/a.nif'] }]),
    paths: { overwriteDir: '/instance/overwrite', downloadsDir: '', modDirs: new Map([['My Mod', '/instance/mods/My Mod']]), sourceDirs: new Map() },
  });
  const myModView = async () => viewOver(myMod, { value: await myModValue() });
  type Find = (view: ModsView) => Promise<Row>;
  const modRow: Find = ({ row }) => row('My Mod');
  const textures: Find = async (view) => await view.row('textures', await modRow(view));
  const leaf: Find = async (view) => await view.row('a.dds', await textures(view));
  const archived: Find = async (view) => await view.row('a.nif', await view.row('meshes', await view.row('Main.ba2', await modRow(view))));
  const overwrite: Find = ({ row }) => row('Overwrite');

  it.each<[string, Find[], Find[], string]>([
    ['the clicked mod\'s own folder, as the value names it', [], [modRow], '/instance/mods/My Mod'],
    ['the overwrite folder from the Overwrite row', [], [overwrite], '/instance/overwrite'],
    ['a clicked file where it sits in its mod, a link too', [], [leaf], '/instance/mods/My Mod/textures/a.dds'],
    ['the one selected file from the palette', [leaf], [], '/instance/mods/My Mod/textures/a.dds'],
    ['a clicked folder where the value says it sits', [], [textures], '/instance/mods/My Mod/textures'],
    ['the archive that holds a clicked archived file', [], [archived], '/instance/mods/My Mod/Main.ba2'],
    ['the one selected folder from the palette', [textures], [], '/instance/mods/My Mod/textures'],
  ])('reveals %s', async (_case, selection, args, path) => {
    const view = await myModView();
    view.view.selectRows(await Promise.all(selection.map(async (find) => await find(view))));

    await view.run('modbench.mod.openFolder', ...await Promise.all(args.map(async (find) => await find(view))));

    expect(revealed()).toEqual([path]);
  });

  it.each<[string, string, string]>([
    ['a mod no folder holds, naming it, rather than returning in silence', 'Folderless Mod', 'Folderless Mod'],
    ['the Overwrite row while the value names no folder for it, rather than revealing an empty path', 'Overwrite', 'Overwrite'],
  ])('refuses %s', async (_case, clicked, name) => {
    const { run, row, reporter } = viewOver([mod('Folderless Mod')]);

    await run('modbench.mod.openFolder', await row(clicked));

    expect(revealed()).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: `Failed to open the folder of "${name}".`, detail: 'No folder holds it.' }]);
  });

  it.each<[string, string[]]>([
    ['several rows', ['My Mod', 'Overwrite']],
    ['a separator', ['Group']],
  ])('reveals nothing from the palette over a selection of %s', async (_what, selection) => {
    const { run, row, view } = viewOver([mod('My Mod'), separator('Group')]);
    view.selectRows(await Promise.all(selection.map(async (name) => await row(name))));

    await run('modbench.mod.openFolder');

    expect(revealed()).toEqual([]);
  });

  it.each<[string, Find, string]>([
    ['a file by its path in its mod', leaf, 'textures/a.dds'],
    ['a mod by its name', modRow, 'My Mod'],
  ])('reports a reveal that fails, naming %s', async (_case, find, name) => {
    const view = await myModView();
    seen.commands.set('revealInExplorer', () => Promise.reject(new Error('no explorer')));

    await view.run('modbench.mod.openFolder', await find(view));

    expect(view.reporter.reports).toEqual([{ severity: 'error', message: `Failed to open the folder of "${name}".`, detail: 'no explorer' }]);
  });
});

describe('view on Nexus: one command for a mod and for a downloaded file', () => {
  const nexusMod = (name: string, nexusId?: string, gameName?: string): ModlistEntry => ({ ...mod(name), nexusId, gameName });
  const nexusView = (...mods: ModlistEntry[]) => viewOver(mods, { value: instanceValueFixture({ mods, gameName: 'Skyrim Special Edition' }) });
  const downloadedFileRow = (nexusModId?: string, gameName?: string) => ({ nexusModId, gameName });

  it.each<[string, (view: ModsView) => Promise<unknown>, string]>([
    ['a mod row', ({ row }) => row('My Mod'), 'https://www.nexusmods.com/skyrimspecialedition/mods/42'],
    ['a downloaded file row', () => Promise.resolve(downloadedFileRow('123')), 'https://www.nexusmods.com/skyrimspecialedition/mods/123'],
  ])('opens the mod\'s Nexus page from %s', async (_case, clicked, page) => {
    const view = nexusView(nexusMod('My Mod', '42'));

    await view.run('modbench.mod.viewOnNexus', await clicked(view));

    expect(seen.openedExternally).toEqual([page]);
  });

  it('takes the domain from the game the mod\'s metadata names, not the instance\'s', async () => {
    const { run, row } = nexusView(nexusMod('My Mod', '42', 'Starfield'));

    await run('modbench.mod.viewOnNexus', await row('My Mod'));
    await run('modbench.mod.viewOnNexus', downloadedFileRow('123', 'Fallout 4'));

    expect(seen.openedExternally).toEqual(['https://www.nexusmods.com/starfield/mods/42', 'https://www.nexusmods.com/fallout4/mods/123']);
  });

  it.each<[string, (view: ModsView) => Promise<unknown>]>([
    ['a mod', ({ row }) => row('My Mod')],
    ['a downloaded file', () => Promise.resolve(downloadedFileRow('42', 'EnderalSE'))],
  ])('opens no page for %s of a game the registry holds no domain for, and names the game', async (_row, clicked) => {
    const view = nexusView(nexusMod('My Mod', '42', 'EnderalSE'));

    await view.run('modbench.mod.viewOnNexus', await clicked(view));

    expect([seen.openedExternally, view.reporter.reports]).toEqual([[], [
      { severity: 'error', message: 'Failed to open the Nexus page of mod 42.', detail: "Nexus has no domain for the game 'EnderalSE'." },
    ]]);
  });

  it('reports a page that fails to open', async () => {
    const { run, row, reporter } = nexusView(nexusMod('My Mod', '42'));
    vi.spyOn(vscodeModule.env, 'openExternal').mockRejectedValueOnce(new Error('no browser'));

    await run('modbench.mod.viewOnNexus', await row('My Mod'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the Nexus page of mod 42.', detail: 'no browser' },
    ]);
  });

  it('opens the selected row\'s Nexus page from the palette, which hands it no row', async () => {
    const { run, row, view } = nexusView(nexusMod('Selected Mod', '123'));
    view.selectRows([await row('Selected Mod')]);

    await run('modbench.mod.viewOnNexus');

    expect(seen.openedExternally).toEqual(['https://www.nexusmods.com/skyrimspecialedition/mods/123']);
  });

  it('opens the right-clicked row\'s page, never the selected one\'s', async () => {
    const { run, row, view } = nexusView(nexusMod('My Mod', '42'), nexusMod('Selected Mod', '123'));
    view.selectRows([await row('Selected Mod')]);

    await run('modbench.mod.viewOnNexus', await row('My Mod'));

    expect(seen.openedExternally).toEqual(['https://www.nexusmods.com/skyrimspecialedition/mods/42']);
  });

  it('opens nothing for a row with no Nexus id', async () => {
    const { run, row } = nexusView(nexusMod('My Mod'));

    await run('modbench.mod.viewOnNexus', downloadedFileRow());
    await run('modbench.mod.viewOnNexus', await row('My Mod'));

    expect(seen.openedExternally).toEqual([]);
  });
});

describe('copy value in Mods: one line for each selected row copy value takes', () => {
  const mods = [mod('Alpha'), separator('Group A'), mod('Beta'), separator('Group B'), mod('Armour')];
  const archive = file('Armour', 'Armour - Main.ba2');
  const copyView = async () => viewOver(mods, {
    value: await indexedValueOf(mods, { Armour: { files: [file('Armour', 'textures/armour/a.dds'), archive], folders: [folder('Armour', 'textures'), folder('Armour', 'textures/armour')] } },
      { files: [] }, [{ origin: modOrigin('Armour'), archive: archive.sourcePath, files: ['meshes/a.nif'] }]),
  });
  type Find = (view: ModsView) => Promise<Row>;
  const named = (name: string): Find => ({ row }) => row(name);
  const textures: Find = async (view) => await view.row('textures', await view.row('Armour'));
  const leaf: Find = async (view) => await view.row('a.dds', await view.row('armour', await textures(view)));
  const archived: Find = async (view) => await view.row('a.nif', await view.row('meshes', await view.row('Armour - Main.ba2', await view.row('Armour'))));
  const rowsOf = async (view: ModsView, finds: readonly Find[]): Promise<Row[]> => await Promise.all(finds.map(async (find) => await find(view)));

  it.each<[string, Find, string]>([
    ['a mod its own name', named('Alpha'), 'Alpha'],
    ['a separator its own name', named('Group A'), 'Group A'],
    ['a file its path in its mod', leaf, 'textures/armour/a.dds'],
    ['a folder its path in its mod', textures, 'textures'],
    ['a file in an archive its path in its mod, through the archive', archived, 'Armour - Main.ba2/meshes/a.nif'],
  ])('copies for %s right-clicked alone', async (_case, clicked, text) => {
    const view = await copyView();

    expect(view.mods.copyValue.text(await clicked(view), undefined)).toBe(text);
  });

  it('copies every selected mod\'s and separator\'s name, one per line, when the selection mixes kinds', async () => {
    const view = await copyView();
    const selected = await rowsOf(view, ['Alpha', 'Group A', 'Beta', 'Group B'].map(named));

    expect(view.mods.copyValue.text(selected[2], selected)).toBe('Alpha\nGroup A\nBeta\nGroup B');
  });

  it('excludes the Overwrite row from a selection that includes it', async () => {
    const view = await copyView();
    const [alpha, overwrite] = await rowsOf(view, [named('Alpha'), named('Overwrite')]);

    expect(view.mods.copyValue.text(alpha, [alpha, overwrite])).toBe('Alpha');
  });

  it('is undefined for the Overwrite row, so another surface\'s copy takes over', async () => {
    const view = await copyView();

    expect(view.mods.copyValue.text(await view.row('Overwrite'), undefined)).toBeUndefined();
  });

  it('copies the view\'s selection for the Mods key\'s own args', async () => {
    const view = await copyView();
    view.view.selectRows(await rowsOf(view, ['Alpha', 'Group A', 'Overwrite'].map(named)));

    expect(view.mods.copyValue.text(MODS_KEY_ARGS, undefined)).toBe('Alpha\nGroup A');
  });

  it('copies each selected file\'s and folder\'s path in its mod beside the mods\' names, from a click and from the key', async () => {
    const view = await copyView();
    const [alpha, folderRow, fileRow] = await rowsOf(view, [named('Alpha'), textures, leaf]);
    const clicked = view.mods.copyValue.text(folderRow, [alpha, folderRow, fileRow]);
    view.view.selectRows([fileRow, folderRow]);

    expect([clicked, view.mods.copyValue.text(MODS_KEY_ARGS, undefined)]).toEqual(['Alpha\ntextures\ntextures/armour/a.dds', 'textures/armour/a.dds\ntextures']);
  });
});

const filesOfM = (files: readonly OriginFile[]): Partial<InstanceReading> => ({
  modFiles: new Map([['M', { origin: 'M', folder: '/instance/M', files: [...files], folders: [], notes: [] }]]),
});

const viewOfM = async (files: OriginFile[], { read = files, folders = [], ...over }: Over & { read?: readonly OriginFile[]; folders?: ReturnType<typeof folder>[] } = {}) => {
  const mods = over.listed ?? [mod('M')];
  return viewOver(mods, { value: await indexedValueOf([...mods], { M: { files, folders } }), reading: filesOfM(read), ...over });
};

describe('exclude and include file: every selected file, in the right-clicked row\'s direction', () => {
  const origin = { kind: 'mod', name: 'M' } as const;
  const files = [
    file('M', 'a.dds'), file('M', 'b.dds.mohidden', true),
    { ...file('M', 'x.mohidden/c.dds', true), markedExcluded: false }, file('M', 'x.mohidden/d.dds.mohidden', true),
  ];
  const viewOfFiles = () => viewOfM(files, { folders: [folder('M', 'x.mohidden', true)] });
  const marked = (relativePath: string, mark: 'Excluded' | 'Included'): AdapterCall => ({ verb: 'markOriginFile', origin, relativePath, mark });

  it('sends every selected file to the write, whatever the view shows each as, and nothing else', async () => {
    const { run, row, adapter, reporter } = await viewOfFiles();
    const m = await row('M');
    const included = await row('a.dds', m);

    await run('modbench.mod.excludeFile', included, [included, await row('b.dds.mohidden', m), m]);

    expect(adapter.calls).toEqual([marked('a.dds', 'Excluded'), marked('b.dds.mohidden', 'Excluded')]);
    expect(reporter.reports).toEqual([]);
  });

  it('includes the view\'s selection from the palette, where no row is right-clicked', async () => {
    const { run, row, view, adapter } = await viewOfFiles();
    view.selectRows([await row('b.dds.mohidden', await row('M'))]);

    await run('modbench.mod.includeFile');

    expect(adapter.calls).toEqual([marked('b.dds.mohidden', 'Included')]);
  });

  it.each([
    ['excludeFile', 'Excluded', 'a.dds'], ['includeFile', 'Included', 'b.dds.mohidden'],
  ] as const)('%s takes a file its folder excludes by its own name, with the selection\'s others', async (verb, mark, clickedName) => {
    const { run, row, adapter } = await viewOfFiles();
    const m = await row('M');
    const hiding = await row('x.mohidden', m);
    const clicked = await row(clickedName, m);

    await run(`modbench.mod.${verb}`, clicked, [clicked, await row('c.dds', hiding), await row('d.dds.mohidden', hiding)]);

    expect(adapter.calls).toEqual([
      marked(clickedName, mark), marked('x.mohidden/c.dds', mark), marked('x.mohidden/d.dds.mohidden', mark),
    ]);
  });

  it('writes nothing and reports nothing over a selection with no file', async () => {
    const { run, row, view, adapter, reporter } = await viewOfFiles();
    view.selectRows([await row('M')]);

    await run('modbench.mod.excludeFile');

    expect([adapter.calls, reporter.reports]).toEqual([[], []]);
  });
});

describe('ignore and unignore file: every selected file, in the command\'s direction', () => {
  const origin = { kind: 'mod', name: 'M' } as const;
  const ignoringThrough = (ignoreFiles: InstanceRepositoryCommands['ignoreFiles']) =>
    viewOfM([file('M', 'a.dds'), file('M', 'b.dds')], {
      manifestGestures: { toolboxView: 'modbench.toolbox', say: () => undefined, commands: { updateManifest: vi.fn(), restoreFromManifest: vi.fn(), ignoreFiles } },
    });

  it.each([['ignoreFile', true], ['unignoreFile', false]] as const)('%s hands every selected file to the manifest write, and nothing else', async (verb, ignore) => {
    const ignoreFiles = vi.fn<InstanceRepositoryCommands['ignoreFiles']>(() => Promise.resolve({ landed: [], refused: [] }));
    const { run, row } = await ignoringThrough(ignoreFiles);
    const m = await row('M');
    const fileA = await row('a.dds', m);

    await run(`modbench.mod.${verb}`, fileA, [fileA, await row('b.dds', m), m]);

    expect(ignoreFiles.mock.calls).toEqual([[[{ origin, relativePath: 'a.dds' }, { origin, relativePath: 'b.dds' }], ignore]]);
  });

  it('writes nothing over a selection with no file', async () => {
    const ignoreFiles = vi.fn<InstanceRepositoryCommands['ignoreFiles']>(() => Promise.resolve({ landed: [], refused: [] }));
    const { run, row, view } = await ignoringThrough(ignoreFiles);
    view.selectRows([await row('M')]);

    await run('modbench.mod.ignoreFile');

    expect(ignoreFiles).not.toHaveBeenCalled();
  });
});

describe('a Mods gesture that writes ends on the Instance loader\'s read, with the view\'s progress bar open throughout', () => {
  const mods = [mod('Mod A'), mod('Mod B'), separator('Group A')];
  const aDds = file('Mod A', 'a.dds');
  const eachWriteInOrder: InstanceAnswers = { refusals: (call) => { progressSteps.push(call.verb); return undefined; } };

  it.each<[string, (view: ModsView) => Promise<unknown>, string[]]>([
    ['disable over a selection, in one write', async ({ run, row }) => {
      const modA = await row('Mod A');
      return run('modbench.mod.disable', modA, [modA, await row('Mod B')]);
    }, ['changeModOrder']],
    ['move', async ({ run, row }) => {
      const modA = await row('Mod A');
      return run('modbench.mod.move', modA, [modA], { place: { kind: 'ungrouped' }, end: 'losing' });
    }, ['changeModOrder']],
    ['uninstall', async ({ run, row }) => run('modbench.mod.uninstall', await row('Mod A')), ['trashEntryFolder', 'changeModOrder']],
    ['separator delete', async ({ run, row }) => run('modbench.separator.delete', await row('Group A')), ['trashEntryFolder', 'changeModOrder']],
    ['separator add', async ({ run, row }) => {
      typing('New Group');
      return run('modbench.separator.add', await row('Group A'));
    }, ['changeModOrder']],
    ['create empty mod', ({ run }) => {
      typing('New Mod');
      return run('modbench.mod.createEmpty');
    }, ['createModFolder', 'changeModOrder']],
    ['exclude file', async ({ run, row }) => run('modbench.mod.excludeFile', await row('a.dds', await row('Mod A'))), ['markOriginFile']],
  ])('%s', async (_name, gesture, writes) => {
    const view = viewOver(mods, {
      value: await indexedValueOf(mods, { 'Mod A': { files: [aDds] } }),
      answers: eachWriteInOrder,
      reading: {
        sourceModFolders: repositoriesOf({ 'Mod A': '/instance/source/Mod A' }),
        modFiles: new Map([['Mod A', { origin: 'Mod A', folder: '/instance/Mod A', files: [aDds], folders: [], notes: [] }]]),
      },
      ask: confirming,
    });

    await gesture(view);

    expect(progressSteps).toEqual(['progress opens on modbench.modList', ...writes, 'progress closes']);
  });
});

describe('open source: a source mod\'s source folder', () => {
  const mods = [mod('Source Mod'), mod('Plain Mod')];
  const sourceView = () => viewOver(mods, {
    value: instanceValueFixture({
      mods,
      listedSourceMods: new Set(['Source Mod']),
      paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map(), sourceDirs: new Map([['Source Mod', '/instance/source/Source Mod']]) },
    }),
  });

  it('reveals the clicked source mod\'s source folder, as the value names it', async () => {
    const { run, row } = sourceView();

    await run('modbench.mod.openSource', await row('Source Mod'));

    expect(revealed()).toEqual(['/instance/source/Source Mod']);
  });

  it('refuses a mod with no repository, naming it', async () => {
    const { run, row, reporter } = sourceView();

    await run('modbench.mod.openSource', await row('Plain Mod'));

    expect(revealed()).toEqual([]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the source of "Plain Mod".', detail: 'It is not a source mod.' },
    ]);
  });

  it('reveals nothing from the palette over a selection of several rows', async () => {
    const { run, row, view } = sourceView();
    view.selectRows([await row('Source Mod'), await row('Plain Mod')]);

    await run('modbench.mod.openSource');

    expect(revealed()).toEqual([]);
  });
});

describe('the mod gestures, called by the agent', () => {
  const mods = [mod('Mod A'), mod('Mod B'), separator('Group'), separator('Group B'), mod('Selected Mod')];
  const ofMods = (...names: string[]) => new AgentCall(names.map((name) => ({ kind: 'mod' as const, name })), {});
  const withSelection = async () => {
    const view = viewOver(mods);
    view.view.selectRows([await view.row('Selected Mod')]);
    return view;
  };

  describe('move', () => {
    const group = { kind: 'separator', name: 'Group' } as const;

    it('moves the mods given to the place given, never the selection, opening no pick, and answers the outcome', async () => {
      const { run, adapter, reporter } = await withSelection();

      const answered = await run('modbench.mod.move', new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'mod', name: 'Mod B' }], { place: group, end: 'winning' }));

      expect(adapter.calls).toEqual([modOrderChange({ kind: 'moveMods', mods: ['Mod A', 'Mod B'], place: group, end: 'winning' })]);
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Mod A', 'Mod B'], refused: [] } });
      expect(reporter.reports).toEqual([]);
      nothingOpened();
    });

    it('moves separators given as separators to a separator place, never the selection, and answers the outcome', async () => {
      const { run, adapter } = await withSelection();
      const above = { kind: 'separator', name: 'Group B' } as const;

      const answered = await run('modbench.mod.move', new AgentCall([{ kind: 'separator', name: 'Group' }], { place: above, end: 'winning' }));

      expect(adapter.calls).toEqual([modOrderChange({ kind: 'moveSeparators', separators: ['Group'], place: above, end: 'winning' })]);
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Group'], refused: [] } });
      nothingOpened();
    });

    it('refuses an Argument that mixes mods and separators, as the view moves neither', async () => {
      const { run, adapter } = await withSelection();

      await expect(run('modbench.mod.move', new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'separator', name: 'Group' }], { place: group, end: 'winning' })))
        .rejects.toBeInstanceOf(Refusal);

      expect(adapter.calls).toEqual([]);
    });
  });

  describe('uninstall for an agent', () => {
    it('uninstalls the mods given when forced, never the selection, confirming nothing', async () => {
      const { run, adapter, ask } = await withSelection();

      const answered = await run('modbench.mod.uninstall', new AgentCall(ofMods('Mod A', 'Mod B').argument, { force: true }));

      expect(adapter.calls.filter((call) => call.verb === 'trashEntryFolder')).toEqual([trashed('mod', 'Mod A'), trashed('mod', 'Mod B')]);
      expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Mod A' }, { name: 'Mod B' }], refused: [] }, partial: [] });
      expect(ask.asked).toEqual([]);
    });

    it('refuses each mod without force, listing what it loses and naming force, trashing nothing', async () => {
      const { run, adapter } = await withSelection();

      const answered = await run('modbench.mod.uninstall', ofMods('Mod A', 'Mod B'));

      expect(adapter.calls).toEqual([]);
      expect(answered).toEqual({
        applied: true,
        outcome: {
          landed: [],
          refused: [
            { item: { name: 'Mod A' }, reason: 'it would move its folder to the system trash, and lose its place in mod order and its publisher tags. Request it again with force to uninstall it.' },
            { item: { name: 'Mod B' }, reason: 'it would move its folder to the system trash, and lose its place in mod order and its publisher tags. Request it again with force to uninstall it.' },
          ],
        },
      });
    });
  });

  describe('create empty mod', () => {
    const createCall = (name: string) => new AgentCall([], { name });

    it('creates the mod named, prompting for nothing, and answers the outcome', async () => {
      const { run, adapter, reporter } = viewOver(mods);

      const answered = await run('modbench.mod.createEmpty', createCall('New Mod'));

      expect(adapter.calls[0]).toEqual({ verb: 'createModFolder', mod: 'New Mod' });
      expect(answered).toEqual({ applied: true, outcome: { landed: ['New Mod'], refused: [] }, partial: [] });
      expect(reporter.reports).toEqual([]);
      nothingOpened();
    });

    it('refuses a name a folder holds as a Refusal, creating nothing', async () => {
      const { run, adapter } = viewOver(mods);

      await expect(run('modbench.mod.createEmpty', createCall('Mod A'))).rejects.toEqual(
        new Refusal('A mod named "Mod A" already exists. Install its next release from Downloads, or uninstall it to install anew.'));

      expect(adapter.calls).toEqual([]);
    });

    it('leaves a blank name to the command, which refuses it for the view as for the agent', async () => {
      const { run, adapter, reporter } = viewOver(mods);

      const answered = await run('modbench.mod.createEmpty', createCall('  '));
      typing('  ');
      await run('modbench.mod.createEmpty');

      expect(adapter.calls).toEqual([]);
      expect(answered).toEqual({ applied: false, refusal: 'Failed to create "  ".', detail: 'A mod name cannot be empty.' });
      expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to create "  ".', detail: 'A mod name cannot be empty.' }]);
    });
  });

  it.each([
    ['modbench.mod.excludeFile', 'Excluded'],
    ['modbench.mod.includeFile', 'Included'],
  ] as const)('%s marks the files given, never the selection, and answers the outcome', async (command, mark) => {
    const origin = { kind: 'mod', name: 'M' } as const;
    const { run, row, view, adapter, reporter } = await viewOfM([file('M', 'a.dds'), file('M', 'sel.dds')]);
    view.selectRows([await row('sel.dds', await row('M'))]);

    const answered = await run(command, new AgentCall([{ kind: 'file', origin, relativePath: 'a.dds' }], {}));

    expect(adapter.calls).toEqual([{ verb: 'markOriginFile', origin, relativePath: 'a.dds', mark }]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ origin, relativePath: 'a.dds' }], refused: [] } });
    expect(reporter.reports).toEqual([]);
    nothingOpened();
  });
});

describe('the separator gestures, called by the agent', () => {
  const mods = [separator('Group A'), mod('Mod A'), separator('Group B'), separator('Selected Group')];
  const group = (name: string) => ({ kind: 'separator' as const, name });
  const withSelection = async () => {
    const view = viewOver(mods);
    view.view.selectRows([await view.row('Selected Group')]);
    return view;
  };

  it.each([
    ['a mod', { kind: 'mod', name: 'Mod A' }],
    ['a separator', group('Group A')],
  ] as const)('add adds the separator named beside %s given, never the selection, asking nothing, and answers the outcome', async (_, anchor) => {
    const { run, adapter, reporter, ask } = await withSelection();

    const answered = await run('modbench.separator.add', new AgentCall([anchor], { name: 'New Section' }));

    expect(adapter.calls).toEqual([modOrderChange({ kind: 'addSeparator', separator: 'New Section', anchor })]);
    expect(answered).toEqual({ applied: true, outcome: { landed: ['New Section'], refused: [] } });
    expect([reporter.reports, ask.asked, seen.inputBoxes]).toEqual([[], [], []]);
  });

  it('add refuses an Argument of more than one entry, writing nothing', async () => {
    const { run, adapter } = await withSelection();

    await expect(run('modbench.separator.add', new AgentCall([group('Group A'), group('Group B')], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);

    expect(adapter.calls).toEqual([]);
  });

  describe('delete for an agent', () => {
    it('deletes the separators given when forced, never the selection, asking nothing, and answers the outcome', async () => {
      const { run, adapter, reporter, ask } = await withSelection();

      const answered = await run('modbench.separator.delete', new AgentCall([group('Group A'), group('Group B')], { force: true }));

      expect(adapter.calls.filter((call) => call.verb === 'trashEntryFolder')).toEqual([trashed('separator', 'Group A'), trashed('separator', 'Group B')]);
      expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Group A' }, { name: 'Group B' }], refused: [] }, partial: [] });
      expect([reporter.reports, ask.asked, seen.inputBoxes]).toEqual([[], [], []]);
    });

    it('refuses each separator without force, naming the separator its mods would join and force, deleting nothing', async () => {
      const { run, adapter } = await withSelection();

      const answered = await run('modbench.separator.delete', new AgentCall([group('Group A')], {}));

      expect(adapter.calls).toEqual([]);
      expect(answered).toEqual({
        applied: true,
        outcome: {
          landed: [],
          refused: [
            { item: { name: 'Group A' }, reason: 'its mods would join "Group B". Request it again with force to delete it.' },
          ],
        },
      });
    });
  });
});

describe('a Mods selection gesture reports a refusal through the shared reporter, once', () => {
  const listed = [separator('Group A'), mod('Mod A'), separator('Group B'), mod('Mod C'), mod('M')];
  const shown = [...listed, mod('Mod B')];
  const trash = (path: string): Promise<void> =>
    (['/instance/mods/Mod C', '/instance/mods/Group B'].includes(path) ? Promise.reject(new Error('trash unavailable')) : Promise.resolve());
  const fileOf = async ({ row }: ModsView, name: string) => await row(name, await row('M'));

  const gestures = {
    uninstall: async ({ run, row }: ModsView) => {
      const modA = await row('Mod A');
      return run('modbench.mod.uninstall', modA, [modA, await row('Mod C')]);
    },
    'separator delete': async ({ run, row }: ModsView) => {
      const groupA = await row('Group A');
      return run('modbench.separator.delete', groupA, [groupA, await row('Group B')]);
    },
    enable: async ({ run, row }: ModsView) => {
      const modA = await row('Mod A');
      return run('modbench.mod.enable', modA, [modA, await row('Mod B')]);
    },
    move: async ({ run, row }: ModsView) => {
      answers.createdQuickPick = (items) => items.find((item) => item.label === 'Ungrouped');
      const modA = await row('Mod A');
      return run('modbench.mod.move', modA, [modA, await row('Mod B')]);
    },
    'exclude file': async (view: ModsView) => {
      const included = await fileOf(view, 'a.dds');
      return view.run('modbench.mod.excludeFile', included, [included, await fileOf(view, 'c.dds')]);
    },
  };
  const viewAnswering = async (answered: InstanceAnswers) => viewOver(shown, {
    listed, answers: answered, trash, ask: confirming, reading: filesOfM([file('M', 'a.dds')]),
    value: await indexedValueOf(shown, { M: { files: [file('M', 'a.dds'), file('M', 'c.dds')] } }),
  });

  it.each<[keyof typeof gestures, InstanceAnswers, string, string]>([
    ['uninstall', {}, 'Could not uninstall 1 of 2 mods.', '"Mod C" (trash unavailable)'],
    ['separator delete', {}, 'Could not delete 1 of 2 separators.', '"Group B" (trash unavailable)'],
    ['enable', {}, 'Could not enable 1 of 2 mods.', '"Mod B" (Mod not found in modlist: Mod B)'],
    ['move', {}, 'Could not move 1 of 2 mods.', '"Mod B" (Mod not found in modlist: Mod B)'],
    ['exclude file', {}, 'Could not exclude 1 of 2 files.', '"M/c.dds" ("c.dds" is gone from disk.)'],
  ])('%s names the refused item and why, while the others land', async (name, answered, message, detail) => {
    const view = await viewAnswering(answered);

    await gestures[name](view);

    expect(view.reporter.reports).toEqual([{ severity: 'error', message, detail }]);
  });

  it.each<[keyof typeof gestures, InstanceAnswers, string]>([
    ['uninstall', { unreadablePublisher: 'ENOENT: modlist.txt' }, 'Failed to uninstall mods.'],
    ['separator delete', { unreadReads: { modOrder: 'ENOENT: modlist.txt' } }, 'Failed to delete separators.'],
    ['enable', { refusals: refusing('changeModOrder', 'ENOENT: modlist.txt') }, 'Failed to enable mods.'],
    ['move', { refusals: refusing('changeModOrder', 'ENOENT: modlist.txt') }, 'Failed to move mods.'],
  ])('%s reports a refusal of the whole selection with its cause', async (name, answered, message) => {
    const view = await viewAnswering(answered);

    await gestures[name](view);

    expect(view.reporter.reports).toEqual([{ severity: 'error', message, detail: 'ENOENT: modlist.txt' }]);
  });
});

describe('a Mods gesture called by the agent refuses an Argument of a kind it does not take, writing nothing', () => {
  const plugin = { kind: 'plugin', plugin: { name: 'A.esp', origin: 'Mod A' } } as const;
  const modArgument = { kind: 'mod', name: 'Mod A' } as const;

  it.each<[string, Argument]>([
    ['modbench.mod.enable', plugin],
    ['modbench.mod.move', plugin],
    ['modbench.mod.uninstall', plugin],
    ['modbench.mod.excludeFile', modArgument],
    ['modbench.separator.add', plugin],
    ['modbench.separator.delete', modArgument],
  ])('%s', async (command, argument) => {
    const { run, adapter } = viewOver([mod('Mod A')]);

    await expect(run(command, new AgentCall([argument], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);

    expect(adapter.calls).toEqual([]);
  });
});
