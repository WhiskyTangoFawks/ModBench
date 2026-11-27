import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type * as vscode from 'vscode';
import type { Mod, Separator, InstanceValue, EntryRef } from '../../instanceLoader/instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { labelOf, modsViewOn } from './modsViewOn';
import { seen } from './modsVscode';
import { MODS_KEY_ARGS } from '../gestureEntry';
import { holdRedraws, releaseRedraws } from '../../drivingLib/heldRedraw';
import { modArgumentOf, separatorArgumentOf } from '../../drivingLib/argument';
import { currentBoxOf } from '../../drivingLib/test/nameFilterViewHarness';
import { present } from '../../ports/present';
import { DataTransfer, DataTransferItem, FakeCancellationToken, ThemeColor, ThemeIcon, TreeItem, TreeItemCheckboxState, TreeItemCollapsibleState } from '../../test/vscodeMock';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { HeldModStatuses } from '../../test/heldModStatuses';
import { settled } from '../../test/eventually';
import { file, folder, indexedValueOf } from './indexedValue';

const mod = (name: string, enabled = true, extra: Partial<Mod> = {}): Mod => ({ kind: 'mod', name, enabled, ...extra });
const sep = (name: string, enabled = false): Separator => ({ kind: 'separator', name, enabled });

const valueOf = (mods: ModlistEntry[], extra: Partial<InstanceValue> = {}): InstanceValue => instanceValueFixture({ mods, ...extra });
const overwriteHolding = (count: number): InstanceValue['overwriteFiles'] => Array.from({ length: count }, (_, at) => file('overwrite', `F4SE/${at}.log`));

const SEQUENCE_NOT_READ_YET = 0;

const orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt = (): ModlistEntry[] => [
  mod('Late Tweak'), mod('Early Fix', false), sep('Late Section'), mod('Base Patch'), sep('Early Section'), mod('Old Mod'), mod('Oldest Mod'),
];

type Shown = ReturnType<typeof modsViewOn>;
type Row = vscode.TreeItem;
type Origin = { kind: 'mod'; name: string } | { kind: 'runtimeOutput' };

const over = (mods: ModlistEntry[], extra: Partial<InstanceValue> = {}) => modsViewOn({ value: valueOf(mods, extra) });
const ordered = () => over(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());

const currentBox = currentBoxOf(seen);
const filtered = (shown: Shown, term: string): Shown => {
  shown.mods.nameFilter.open();
  currentBox().type(term);
  return shown;
};
const flattened = (shown: Shown, term: string): Shown => {
  filtered(shown, term);
  currentBox().pressButton();
  return shown;
};
const winningAtTop = async (shown: Shown): Promise<Shown> => {
  await shown.run('modbench.mod.sortWinningAtTop');
  return shown;
};

const redraws = ({ view }: Shown): (Row | undefined)[] => {
  const fired: (Row | undefined)[] = [];
  view.treeDataProvider.onDidChangeTreeData?.((row) => { fired.push(Array.isArray(row) ? undefined : row ?? undefined); });
  return fired;
};
const separatorsOf = async ({ rows }: Shown) => Object.fromEntries((await rows()).filter(({ contextValue }) => contextValue === 'separator').map((row) => [String(labelOf(row)), row.collapsibleState]));
const nameOf = (row: unknown) => modArgumentOf(row)?.name ?? separatorArgumentOf(row)?.name;

async function parentOfShown({ mods, view, parentOf }: Shown, entry: EntryRef): Promise<string | undefined> {
  const reveal = vi.spyOn(view, 'reveal');
  await present(mods.symbolRows.show(entry), `a row for ${entry.name}`)();
  return nameOf(parentOf(expectInstanceOf(present(reveal.mock.calls[0], 'a reveal')[0], TreeItem)));
}

describe('the tree reads as mod order', () => {
  it.each([
    ['losing at the top: the ungrouped mods, then the separators, then Overwrite last', 'modbench.mod.sortLosingAtTop', ['0 Oldest Mod', '1 Old Mod', 'Early Section', 'Late Section', 'Overwrite']],
    ['winning at the top: Overwrite first, then the separators, then the ungrouped mods', 'modbench.mod.sortWinningAtTop', ['Overwrite', 'Late Section', 'Early Section', '1 Old Mod', '0 Oldest Mod']],
  ])('in each direction: %s', async (_case, direction, expected) => {
    const { run, labels } = ordered();

    await run(direction);

    expect(await labels()).toEqual(expected);
  });

  it('draws the whole tree again when the direction flips', async () => {
    const shown = over([mod('Winning'), mod('Losing')]);
    const fired = redraws(shown);

    await winningAtTop(shown);

    expect(fired).toEqual([undefined]);
  });
});

describe('a mod\'s label leads with its position in mod order (mods.md, A row, Mod)', () => {
  it('counts from the losing end at 0, a separator taking a place as MO2 gives it a priority', async () => {
    const { labels, row } = ordered();

    expect([await labels(), await labels(await row('Early Section'))]).toEqual([['0 Oldest Mod', '1 Old Mod', 'Early Section', 'Late Section', 'Overwrite'], ['3 Base Patch']]);
  });

  it('zero-pads to the width of the last position, so the numbers align', async () => {
    const { labels } = over(Array.from({ length: 11 }, (_, at) => mod(`M${10 - at}`)));

    expect((await labels()).slice(0, 2)).toEqual(['00 M0', '01 M1']);
  });

  it('does not renumber when the view flips', async () => {
    const { labels } = await winningAtTop(over([mod('Winner'), mod('Loser')]));

    expect(await labels()).toEqual(['Overwrite', '1 Winner', '0 Loser']);
  });

  it('does not renumber when a filter hides rows', async () => {
    const { labels } = filtered(over([mod('Winner'), mod('Loser')]), 'Winner');

    expect(await labels()).toEqual(['1 Winner', 'Overwrite']);
  });
});

describe('a row\'s identity is its kind and its name', () => {
  it('a mod and a separator that share a name are two rows', async () => {
    const { row } = over([mod('Armor'), sep('Armor')]);
    const separator = await row('Armor');

    expect((await row('Armor', separator)).id).not.toBe(separator.id);
  });

  it('a new instance value leaves every row\'s identity as it was', async () => {
    const { rows, instance } = ordered();
    const idsOf = async () => (await rows()).map(({ id }) => id);
    const before = await idsOf();

    instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt(), { overwriteFiles: overwriteHolding(4) }));

    expect(await idsOf()).toEqual(before);
    expect(new Set(before).size).toBe(before.length);
  });
});

describe('a separator\'s expander', () => {
  it.each<[string, ModlistEntry[], string, Record<string, vscode.TreeItemCollapsibleState>]>([
    ['starts collapsed on a fresh view, and a separator with no mods has none', [mod('Held'), sep('Full'), sep('Empty')], '', { Empty: TreeItemCollapsibleState.None, Full: TreeItemCollapsibleState.Collapsed }],
    ['is expanded while a filter shows only the separator\'s matching mods', [mod('Armor Fix'), mod('Weapons'), sep('Gear'), mod('Armor Pack'), sep('Armory')], 'armo', { Armory: TreeItemCollapsibleState.Collapsed, Gear: TreeItemCollapsibleState.Expanded }],
    ['a separator whose name matches but holds no mods has none while filtering', [sep('Armory')], 'armo', { Armory: TreeItemCollapsibleState.None }],
  ])('follows its mods and the filter: %s', async (_case, mods, term, expected) => {
    expect(await separatorsOf(filtered(over(mods), term))).toEqual(expected);
  });
});

describe('what the view says of itself', () => {
  it('says nothing of an empty list while a separator alone is listed', () => {
    expect(over([sep('Only')]).view.message).toBeUndefined();
  });

  it('holds its redraw while a gesture writes from it, and draws once the gesture ends (common.md, A gesture that writes, story 1)', () => {
    const shown = over([mod('A')]);
    const fired = redraws(shown);

    holdRedraws(MODS_KEY_ARGS.view);
    shown.instance.publish(valueOf([mod('A'), mod('B')]));
    const firedWhileWriting = fired.length;
    releaseRedraws(MODS_KEY_ARGS.view);

    expect([firedWhileWriting, fired.length]).toEqual([0, 1]);
  });

  it('draws a clicked row again with the box its mod\'s value sets (common.md, A gesture that writes, story 2)', async () => {
    const shown = over([mod('A')]);
    const clicked = await shown.row('A');
    const fired = redraws(shown);
    clicked.checkboxState = TreeItemCheckboxState.Unchecked;

    shown.view.check([[clicked, TreeItemCheckboxState.Unchecked]]);

    await settled(() => { expect(fired).toEqual([clicked]); });
    expect((await shown.view.treeDataProvider.getTreeItem(clicked)).checkboxState).toBe(TreeItemCheckboxState.Checked);
  });

  it('says it shows the last good read, with the reason, when a later read fails, and not once a read lands', async () => {
    const { view, instance } = over([mod('A')]);

    instance.fail('EACCES modlist.txt');
    await settled(() => { expect(view.message).toBe('Showing the last good read: EACCES modlist.txt'); });

    instance.publish(valueOf([mod('A')]));
    await settled(() => { expect(view.message).toBeUndefined(); });
  });
});

describe('the Mods view\'s message line (common.md, States, story 6)', () => {
  it('says the last good read once, naming the instance\'s failed read and each mod status that could not be read', async () => {
    const statuses = new HeldModStatuses();
    statuses.reasons.push('the status of "A" could not be read: bad JSON.');
    const { view, instance } = modsViewOn({ value: valueOf([mod('A')], { holdsRepository: true }), statuses });

    instance.fail('EACCES modlist.txt');

    await settled(() => { expect(view.message).toBe('Showing the last good read: EACCES modlist.txt; the status of "A" could not be read: bad JSON.'); });
  });
});

describe('a row\'s parent, which VS Code\'s reveal walks up through getParent and a filter\'s expansion is', () => {
  it('is the separator that holds a mod, and nothing for a root', async () => {
    const { rows, row, parentOf } = ordered();
    const roots = await rows();

    expect(nameOf(parentOf(await row('Early Fix', await row('Late Section'))))).toBe('Late Section');
    expect(roots.map(parentOf)).toEqual(roots.map(() => undefined));
  });
});

describe('the highlight (plugins.md, The highlight, story 3; mods.md, The tree, story 11)', () => {
  const scene = () => over([mod('Held'), mod('Other'), sep('Section'), mod('Loose')]);
  const highlight = ({ mods }: Shown, ...origins: Origin[]) => { mods.drawsHighlight.highlight({ plugins: [], origins }); };
  const allMarked = async ({ rows, row }: Shown) =>
    [...await rows(), ...await rows(await row('Section'))].filter(({ label }) => typeof label === 'object').map(labelOf);

  it.each<[string, Origin[], string[]]>([
    ['marks the whole label of each mod it is handed and of Overwrite, and no other', [{ kind: 'mod', name: 'Loose' }, { kind: 'runtimeOutput' }], ['0 Loose', 'Overwrite']],
    ['marks a collapsed separator that holds a marked mod', [{ kind: 'mod', name: 'Held' }], ['Section', '3 Held']],
  ])('marks by the origins it is handed: %s', async (_case, origins, expected) => {
    const shown = scene();

    highlight(shown, ...origins);

    expect(await allMarked(shown)).toEqual(expected);
  });

  it('clears the mark when handed none', async () => {
    const shown = scene();
    highlight(shown, { kind: 'mod', name: 'Loose' });

    highlight(shown);

    expect(await allMarked(shown)).toEqual([]);
  });

  it('leaves an open separator unmarked, and marks it again once it closes', async () => {
    const shown = scene();
    highlight(shown, { kind: 'mod', name: 'Held' });

    shown.view.expand(await shown.row('Section'));
    const whileOpen = await allMarked(shown);
    shown.view.collapse(await shown.row('Section'));

    expect([whileOpen, await allMarked(shown)]).toEqual([['3 Held'], ['Section', '3 Held']]);
  });

  it('marks a separator made again under the name of one that was open and removed', async () => {
    const shown = scene();
    highlight(shown, { kind: 'mod', name: 'Held' });
    shown.view.expand(await shown.row('Section'));

    shown.instance.publish(valueOf([mod('Held'), mod('Other'), mod('Loose')]));
    shown.instance.publish(valueOf([mod('Held'), mod('Other'), sep('Section'), mod('Loose')]));

    expect(await allMarked(shown)).toEqual(['Section', '3 Held']);
  });

  it('refreshes only the rows whose mark changed', () => {
    const shown = scene();
    const fired = redraws(shown);

    highlight(shown, { kind: 'mod', name: 'Held' });

    expect(fired.map(nameOf).sort()).toEqual(['Held', 'Section']);
  });

  it('keeps the resourceUri the row\'s colour decoration hangs on', async () => {
    const shown = scene();
    const before = (await shown.rows())[0]?.resourceUri?.toString();

    highlight(shown, { kind: 'mod', name: 'Loose' });

    expect((await shown.rows())[0]?.resourceUri?.toString()).toBe(before);
  });
});

describe('the row for an origin, which Go to mod reveals', () => {
  const unfiltered = (shown: Shown) => shown;
  const modOf = (name: string): EntryRef => ({ kind: 'mod', name });

  it.each<[string, (shown: Shown) => Shown, string, string | undefined]>([
    ['is a mod whose separator was never rendered, with that separator as its parent', unfiltered, 'Base Patch', 'Early Section'],
    ['is a root mod with no parent', unfiltered, 'Old Mod', undefined],
    ['is a root mod when grouping is off', (shown) => flattened(shown, 'old mod'), 'Old Mod', undefined],
    ['is a mod a matching separator shows whole, though the mod\'s own name does not match', (shown) => filtered(shown, 'early section'), 'Base Patch', 'Early Section'],
    ['under a grouping filter has the separator its filter shows for it as its parent', (shown) => filtered(shown, 'base'), 'Base Patch', 'Early Section'],
  ])('reveals a mod\'s row under its parent: %s', async (_case, filter, name, parent) => {
    expect(await parentOfShown(filter(ordered()), modOf(name))).toBe(parent);
  });

  it.each<[string, (shown: Shown) => Shown, string]>([
    ['the filter hides with grouping off', (shown) => flattened(shown, 'old mod'), 'Base Patch'],
    ['a matching separator does not show', (shown) => filtered(shown, 'early section'), 'Old Mod'],
    ['a grouping filter hides', (shown) => filtered(shown, 'base'), 'Old Mod'],
  ])('is nothing for a mod %s', (_case, filter, name) => {
    expect(filter(ordered()).mods.symbolRows.show(modOf(name))).toBeUndefined();
  });

  it('is the Overwrite row for the run-time output', async () => {
    const value = await indexedValueOf([mod('A')], { A: { files: [file('A', 'a.esp')] } }, { files: [file('overwrite', 'a.esp')] });
    const { view, row, run } = modsViewOn({ value });
    const reveal = vi.spyOn(view, 'reveal');

    await run('modbench.mod.goToMod', await row('a.esp', await row('A')), undefined, { kind: 'runtimeOutput' });

    expect(present(reveal.mock.calls[0], 'a reveal')[0]).toMatchObject({ contextValue: 'runtimeOutput' });
  });
});

describe('a click on a separator, a mod, Overwrite or a folder only selects', () => {
  it('none of those rows carries a command', async () => {
    const { rows } = over([mod('Nexus Mod', true, { nexusId: '42' }), sep('Section'), mod('Loose')], {
      overwriteFiles: overwriteHolding(5), overwriteFolders: [folder('overwrite', 'F4SE')],
    });
    const roots = await rows();
    const shown = [...roots, ...(await Promise.all(roots.map(async (root) => await rows(root)))).flat()];

    expect(shown.map(({ contextValue }) => contextValue?.split(' ')[0]).sort()).toEqual(['folder', 'mod', 'mod', 'runtimeOutput', 'separator']);
    expect(shown.filter(({ command }) => command !== undefined)).toEqual([]);
  });
});

describe('the Mods tree\'s rows', () => {
  it('renders no row for a folder in mods/ with no modlist line, since mod sync is what adds a line', async () => {
    const { labels } = over([mod('Listed')], { modFolders: [
      { kind: 'mod', name: 'Listed', path: '/instance/mods/Listed', modName: 'Listed' },
      { kind: 'mod', name: 'Dropped In', path: '/instance/mods/Dropped In', modName: 'Dropped In' },
    ] });

    expect(await labels()).toEqual(['0 Listed', 'Overwrite']);
  });

  it('returns a separator’s mods, the entries preceding it, as mod rows with their check boxes, the later file entry first in the default losing-at-top view', async () => {
    const { rows, row } = over([mod('UFO4P', true, { version: 'v2.1.5', nexusId: '4598', installationFileName: 'UFO4P.7z' }), mod('Disabled Mod', false), sep('Section')]);

    expect((await rows(await row('Section'))).map((shown) => [labelOf(shown), shown.checkboxState])).toEqual([
      ['1 Disabled Mod', TreeItemCheckboxState.Unchecked], ['2 UFO4P', TreeItemCheckboxState.Checked],
    ]);
  });

  it('a mod row states its enabled state and whether it has a Nexus id in its contextValue, which the mod-menu when clauses read to offer enable or disable and view on Nexus', async () => {
    const { row } = over([mod('UFO4P', true, { nexusId: '4598' }), mod('Disabled Mod', false)]);

    expect([(await row('UFO4P')).contextValue, (await row('Disabled Mod')).contextValue]).toEqual(['mod hasNexus enabled nonSourceMod', 'mod disabled nonSourceMod']);
  });

  it('a mod row states in its contextValue whether the instance value holds a plugin of it, and whether it holds a repository, which version in git reads on a mod with a plugin and no repository and build reads on a mod with one', async () => {
    const { rows } = over([mod('Patch'), mod('Textures'), mod('SourceMod')], {
      listedSourceMods: new Set(['SourceMod']),
      plugins: [
        { name: 'Patch.esp', origin: 'Patch', path: '/instance/mods/Patch/Patch.esp', line: 0, enabled: true, winning: true },
        { name: 'SourceMod.esp', origin: 'SourceMod', path: '/instance/mods/SourceMod/SourceMod.esp', line: 1, enabled: true, winning: true },
      ],
    });

    expect((await rows()).map((shown) => [nameOf(shown), shown.contextValue])).toEqual([
      ['SourceMod', 'mod enabled holdsPlugin sourceMod'],
      ['Textures', 'mod enabled nonSourceMod'],
      ['Patch', 'mod enabled holdsPlugin nonSourceMod'],
      [undefined, 'runtimeOutput'],
    ]);
  });

  it('hands the driving lib its mod from a mod row, and none from a separator or the Overwrite row', async () => {
    const { row } = over([mod('Patch'), sep('Tools')]);
    const separator = await row('Tools');

    expect([modArgumentOf(await row('Patch', separator)), modArgumentOf(separator), modArgumentOf(await row('Overwrite'))])
      .toEqual([{ kind: 'mod', name: 'Patch' }, undefined, undefined]);
  });

  it('re-renders on a second, later value published after construction, not only the value handed to the constructor', async () => {
    const shown = over([mod('A')]);
    const first = await shown.labels();
    const fired = redraws(shown);

    shown.instance.publish(valueOf([mod('A'), mod('B')]));

    expect([first, fired, await shown.labels()]).toEqual([['0 A', 'Overwrite'], [undefined], ['0 B', '1 A', 'Overwrite']]);
  });

  it('renders no rows before the first read, and the read\'s rows once it lands', async () => {
    const instance = new FakeInstance(valueOf([]), SEQUENCE_NOT_READ_YET);
    const { labels } = modsViewOn({ instance });

    const pending = labels();
    instance.publish(valueOf([mod('A'), mod('B')]));

    expect(await pending).toEqual(['0 B', '1 A', 'Overwrite']);
  });

  it('settles a failed first read, rather than spinning forever, on the one error row naming the reason, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), SEQUENCE_NOT_READ_YET);
    const { labels } = modsViewOn({ instance });

    const pending = labels();
    instance.fail('EACCES: permission denied, open modlist.txt');
    const failed = await pending;
    instance.publish(valueOf([mod('A')]));

    expect([failed, await labels()]).toEqual([['Failed to load: EACCES: permission denied, open modlist.txt'], ['0 A', 'Overwrite']]);
  });

  it('renders a genuinely empty modlist immediately, as the Overwrite row alone, when the first landed value already carries none', async () => {
    expect(await over([]).labels()).toEqual(['Overwrite']);
  });

  describe('a filter narrows the roots', () => {
    const entries = (): ModlistEntry[] => [mod('Zeta'), mod('Alpha Child'), sep('Group A'), mod('Gamma'), sep('Group B'), mod('Alpha'), mod('Beta')];

    it.each([
      { term: 'alpha', roots: ['1 Alpha', 'Group A', 'Overwrite'], children: ['5 Alpha Child'] },
      { term: 'group a', roots: ['Group A', 'Overwrite'], children: ['5 Alpha Child', '6 Zeta'] },
    ])('"$term" with grouping on shows $roots, Group A holding $children', async ({ term, roots, children }) => {
      const { labels, row } = filtered(over(entries()), term);

      expect([await labels(), await labels(await row('Group A'))]).toEqual([roots, children]);
    });

    it('with grouping off shows the matching mods flat, with no separators', async () => {
      expect(await flattened(over(entries()), 'alpha').labels()).toEqual(['1 Alpha', '5 Alpha Child', 'Overwrite']);
    });
  });

  describe('drag-and-drop', () => {
    const dnd = () => over([mod('Alpha'), sep('Group A'), mod('Beta'), mod('Gamma'), sep('Group B'), mod('Delta')]);
    const movesFired = () => seen.executed.filter(([id]) => id === 'modbench.mod.move');
    const movedNames = () => movesFired().map(([, , argument]) => (Array.isArray(argument) ? argument.map(nameOf) : []));

    it('a drop fires move with every dragged row as its Argument, and the place the view shows it landing', async () => {
      const { row, drop } = dnd();
      const [alpha, delta, gamma] = [await row('Alpha', await row('Group A')), await row('Delta'), await row('Gamma', await row('Group B'))];

      await drop([alpha, delta], gamma);

      expect(movesFired()).toEqual([['modbench.mod.move', alpha, [alpha, delta], { place: { kind: 'mod', name: 'Gamma' }, end: 'losing' }]]);
    });

    it('a drop follows the view\'s sort direction', async () => {
      const { row, drop } = await winningAtTop(dnd());

      await drop([await row('Group B')], undefined);

      expect(movesFired().map((call) => call[3])).toEqual([{ place: { kind: 'modOrder' }, end: 'losing' }]);
    });

    it('a refused drop reports why and moves nothing', async () => {
      const { row, drop, reporter } = dnd();
      const delta = await row('Delta');

      await drop([delta], delta);

      expect([movesFired(), reporter.reports]).toEqual([[], [{ severity: 'error', message: 'Could not move mods.', detail: 'Delta is being dragged, so nothing goes onto it.' }]]);
    });

    it('a drag that mixes kinds takes the kind of the row VS Code last added to the selection', async () => {
      const { row, drop } = dnd();
      const [groupB, delta, groupA] = [await row('Group B'), await row('Delta'), await row('Group A')];

      await drop([groupB, delta], groupA);
      await drop([delta, groupB], groupA);

      expect(movedNames()).toEqual([['Delta'], ['Group B']]);
    });

    it.each<[string, (rows: Record<'armour' | 'overwrite' | 'folder' | 'leaf', Row>) => Row[], string[][]]>([
      ['Overwrite alone moves nothing', ({ overwrite }) => [overwrite], []],
      ['a mod beside Overwrite moves the mod alone', ({ armour, overwrite }) => [armour, overwrite], [['Armour']]],
      ['files and folders moves nothing', ({ folder, leaf }) => [folder, leaf], []],
      ['a mod beside a file moves the mod alone', ({ armour, leaf }) => [armour, leaf], [['Armour']]],
    ])('a drag of %s', async (_case, dragged, moved) => {
      const value = await indexedValueOf([mod('Armour'), mod('Other')], { Armour: { files: [file('Armour', 'x/a.dds')], folders: [folder('Armour', 'x')] } });
      const { row, drop } = modsViewOn({ value });
      const armour = await row('Armour');
      const x = await row('x', armour);

      await drop(dragged({ armour, overwrite: await row('Overwrite'), folder: x, leaf: await row('a.dds', x) }), await row('Other'));

      expect(movedNames()).toEqual(moved);
    });

    it.each([
      ['a payload that carries no focused row among its rows', { rows: [] }],
      ['an entry from outside the view', { kind: 'mod', name: 'Delta' }],
    ])('drops nothing of %s, taking only what its own drag carries', async (_case, payload) => {
      const { row, view } = dnd();
      const controller = present(view.options.dragAndDropController, 'the drag and drop controller');
      const transfer = new DataTransfer();
      transfer.set(present(controller.dragMimeTypes[0], 'the drag\'s type'), new DataTransferItem(payload));

      await controller.handleDrop?.(await row('Delta'), transfer, new FakeCancellationToken());

      expect([controller.dropMimeTypes, movesFired()]).toEqual([controller.dragMimeTypes, []]);
    });

    it('a drop asks for no refresh, since a drop moves no row on screen', async () => {
      const shown = dnd();
      const target = await shown.row('Group A');
      const fired = redraws(shown);

      await shown.drop([await shown.row('Delta')], target);

      expect([movesFired().length, fired]).toEqual([1, []]);
    });
  });

  describe('sort order toggle', () => {
    it('toggled to winning-at-top: the mods within a separator, the entries preceding it, are in mod order', async () => {
      const { labels, row } = await winningAtTop(over([mod('First'), mod('Second'), mod('Third'), sep('Section')]));

      expect(await labels(await row('Section'))).toEqual(['3 First', '2 Second', '1 Third']);
    });

    it('the direction applies to the flat list', async () => {
      const shown = flattened(await winningAtTop(over([mod('Alpha'), sep('Group A'), mod('Alpha Child'), mod('Alpha Other')])), 'alpha');

      expect(await shown.labels()).toEqual(['Overwrite', '3 Alpha', '1 Alpha Child', '0 Alpha Other']);
    });

    it('the direction applies to the grouped, filtered list', async () => {
      const { labels, row } = filtered(await winningAtTop(over([mod('Alpha Child'), mod('Alpha Other'), sep('Group A'), mod('Alpha')])), 'alpha');

      expect([await labels(), await labels(await row('Group A'))]).toEqual([['Overwrite', 'Group A', '0 Alpha'], ['3 Alpha Child', '2 Alpha Other']]);
    });
  });

  describe('a mod row, whatever files it wins or loses (mods.md, A row, Mod)', () => {
    const contested = () => indexedValueOf(
      [mod('Winner'), mod('Loser', true, { version: '1.2', nexusId: '42', installationFileName: 'loser.7z' })],
      { Winner: { files: [file('Winner', 'a.dds')] }, Loser: { files: [file('Loser', 'a.dds'), file('Loser', 'b.dds')] } },
    );

    it('shows $(package), the version as its description, and a tooltip of name, version, Nexus mod ID and installation file', async () => {
      const loser = await modsViewOn({ value: await contested() }).row('Loser');

      expect([loser.iconPath, loser.description, loser.tooltip]).toEqual([{ id: 'package' }, '1.2', 'Loser · 1.2 · 42 · loser.7z']);
    });

    it('shows $(repo) for a source mod, and its source folder in the tooltip as what the folder is built from', async () => {
      const value = { ...(await contested()), listedSourceMods: new Set(['Loser']), paths: { ...instanceValueFixture().paths, sourceDirs: new Map([['Loser', '/instance/source/Loser']]) } };
      const { row } = modsViewOn({ value });
      const [winner, loser] = [await row('Winner'), await row('Loser')];

      expect([winner.iconPath, loser.iconPath, winner.tooltip, loser.tooltip]).toEqual([
        { id: 'package' }, { id: 'repo' }, 'Winner', 'Loser · 1.2 · 42 · loser.7z · built from /instance/source/Loser',
      ]);
    });
  });

  describe('Overwrite row, pinned outside separator grouping, over the value\'s own files', () => {
    const overwriteRow = (extra: Partial<InstanceValue>) => over([mod('Alpha'), sep('Group A'), mod('Beta')], extra).row('Overwrite');

    it.each([
      ['holding files: its count as the description and a tinted folder icon', 3, '3', new ThemeIcon('folder', new ThemeColor('charts.red'))],
      ['holding nothing: still a row, with no description and an untinted folder icon', 0, undefined, new ThemeIcon('folder')],
    ])('counts its files: %s', async (_case, count, description, icon) => {
      const row = await overwriteRow({ overwriteFiles: overwriteHolding(count) });

      expect([labelOf(row), row.description, row.iconPath]).toEqual(['Overwrite', description, icon]);
    });

    it('says what Overwrite is, and nothing of deploy', async () => {
      expect((await overwriteRow({ overwriteFiles: overwriteHolding(2) })).tooltip).toBe('The files tools wrote while MO2 ran them, which win over every mod.');
    });

    it('names the mod manager the value names, not MO2 over another manager\'s instance', async () => {
      const row = await overwriteRow({ managerNames: { manager: 'Another Manager', modOrderFile: 'order.txt', downloadedFileMetadataFile: 'order.metadata' } });

      expect(row.tooltip).toBe('The files tools wrote while Another Manager ran them, which win over every mod.');
    });

    it('is not a mod: no check box, no click, a resourceUri no file shares, so only the Mods view\'s own decorations reach its label, and its own menu', async () => {
      const row = await overwriteRow({ overwriteFiles: overwriteHolding(2) });

      expect([row.checkboxState, row.command, row.resourceUri?.scheme, row.resourceUri?.path, row.contextValue]).toEqual([undefined, undefined, 'modbench-overwrite', '/', 'runtimeOutput']);
    });
  });
});

describe('separators that share a prefix', () => {
  const grouped = () => over([mod('Rock'), sep('textures - Retextures'), mod('Fix'), sep('textures - Fixes'), mod('Lone'), sep('Plain'), mod('Base')]);

  it('are reversed with the view, group and children alike', async () => {
    const { labels, row } = await winningAtTop(grouped());

    expect([await labels(), await labels(await row('textures'))]).toEqual([['Overwrite', 'textures', 'Plain', '0 Base'], ['Retextures', 'Fixes']]);
  });

  it('give a separator the group as its parent, and a mod the separator', async () => {
    const shown = grouped();
    const group = await shown.row('textures');

    expect([labelOf(expectInstanceOf(shown.parentOf(await shown.row('textures - Fixes', group)), TreeItem)), shown.parentOf(group), await parentOfShown(shown, { kind: 'mod', name: 'Fix' })])
      .toEqual(['textures', undefined, 'textures - Fixes']);
  });

  it('show their group under a filter while a mod under it shows, and expand it', async () => {
    const { rows, labels } = filtered(grouped(), 'rock');
    const [group] = await rows();

    expect([await labels(), group?.collapsibleState, await labels(group)]).toEqual([['textures', 'Overwrite'], TreeItemCollapsibleState.Expanded, ['Retextures']]);
  });

  it('give each run of a prefix an id of its own, though a prefix spells a run', async () => {
    const { rows } = await winningAtTop(over([sep('a - x'), sep('a - y'), sep('Plain'), sep('a - z'), sep('a - w'), sep('a#2 - m'), sep('a#2 - n')]));

    const groups = (await rows()).filter(({ contextValue }) => contextValue === 'separatorGroup');

    expect([groups.map(labelOf), new Set(groups.map(({ id }) => id)).size]).toEqual([['a', 'a', 'a#2'], 3]);
  });

  it('leave a nested group closed that the filter matches by its label, and open the groups above it', async () => {
    const { rows, labels } = filtered(over([mod('M1'), sep('Pack - Core - Alpha'), mod('M2'), sep('Pack - Core - Beta')]), 'core');
    const pack = present((await rows())[0], 'the Pack group');
    const core = present((await rows(pack))[0], 'the Core group');

    expect([pack.collapsibleState, core.collapsibleState, await labels(core)]).toEqual([TreeItemCollapsibleState.Expanded, TreeItemCollapsibleState.Collapsed, ['Beta', 'Alpha']]);
  });

  it('show no group while a filter flattens the view', async () => {
    expect(await flattened(grouped(), 'lone').labels()).toEqual(['2 Lone', 'Overwrite']);
  });
});

describe('what a change asks the Mods view for again (common.md, A view, story 13)', () => {
  const listed = { A: { files: [file('A', 'a.dds')] }, B: { files: [file('B', 'b.dds')] } };

  it('asks again for the row of the mod whose files changed alone', async () => {
    const before = await indexedValueOf([mod('A'), mod('B')], listed);
    const { files, filesByMod, foldersByMod, stackedCopies } = await indexedValueOf([mod('A'), mod('B')], { ...listed, A: { files: [...listed.A.files, file('A', 'new.dds')] } });
    const shown = modsViewOn({ value: before });
    await shown.rows();
    const fired = redraws(shown);

    shown.instance.publish({ ...before, files, filesByMod, foldersByMod, stackedCopies });

    expect(fired.map(nameOf)).toEqual(['A']);
  });

  it('asks again for the row of the mod whose status changed alone', async () => {
    const statuses = new HeldModStatuses();
    const shown = modsViewOn({ value: await indexedValueOf([mod('A'), mod('B')], listed), statuses });
    await shown.rows();
    const fired = redraws(shown);

    statuses.answer([], new Set(['B']));

    expect(fired.map(nameOf)).toEqual(['B']);
  });

  it('draws the tree again when the status of a mod the filter hides changes, so its badge counts it', async () => {
    const statuses = new HeldModStatuses();
    const shown = filtered(modsViewOn({ value: await indexedValueOf([mod('A'), mod('B')], listed), statuses }), 'a.dds');
    await shown.rows();
    const fired = redraws(shown);

    statuses.answer([], new Set(['B']));

    expect(fired).toEqual([undefined]);
  });
});
