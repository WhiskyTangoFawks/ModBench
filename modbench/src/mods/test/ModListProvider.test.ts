import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mod, ModlistEntry, Separator } from '../../instanceLoader/instance';
import type { InstanceValue } from '../../instanceLoader/instance';
import { present } from '../../ports/present';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, uriFrom, DataTransferItem, DataTransfer, FakeCancellationToken,
} from '../../test/vscodeMock';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn((_id: string, ..._args: unknown[]) => Promise.resolve()) }));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  commands: { executeCommand },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile, from: uriFrom }, DataTransferItem, DataTransfer,
}));

import { ModListProvider, SeparatorNode, ModNode, OverwriteNode, type ModlistNode } from '../ModListProvider';
import { modOfRow } from '../../drivingLib/modRow';
import { ErrorNode } from '../../drivingLib/errorNode';
import { withUnreadCorpusInstance } from '../../test/mo2/unreadCorpusInstance';
import { expectInstanceOf, expectInstancesOf } from '../../test/expectInstanceOf';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { file, indexedValueOf } from './indexedValue';

const ACTIVE_PROFILE = 'Default';

beforeEach(() => {
  executeCommand.mockClear();
});

const mod = (name: string, enabled = true, extra: Partial<Mod> = {}): Mod => ({
  kind: 'mod', name, enabled, ...extra,
});
const sep = (name: string, enabled = false): Separator => ({ kind: 'separator', name, enabled });

function valueOf(
  mods: ModlistEntry[],
  extra: Partial<Pick<InstanceValue, 'activeProfile' | 'overwriteFiles' | 'paths' | 'managerNames' | 'modFolders'>> = {},
): InstanceValue {
  return instanceValueFixture({
    mods,
    activeProfile: extra.activeProfile ?? ACTIVE_PROFILE,
    overwriteFiles: extra.overwriteFiles ?? [],
    ...(extra.paths ? { paths: extra.paths } : {}),
    ...(extra.managerNames ? { managerNames: extra.managerNames } : {}),
    ...(extra.modFolders ? { modFolders: extra.modFolders } : {}),
  });
}

const overwriteHolding = (count: number): InstanceValue['overwriteFiles'] =>
  Array.from({ length: count }, (_, at) => ({ relativePath: `F4SE/${at}.log`, path: `/instance/overwrite/F4SE/${at}.log`, sourcePath: `/instance/overwrite/F4SE/${at}.log`, excluded: false, excludedByName: false }));

const SEQUENCE_ALREADY_LOADED = 1;
const SEQUENCE_NOT_READ_YET = 0;

class FakeInstance {
  value: InstanceValue;
  sequence: number;
  readFailure: string | undefined;
  private subscribers: ((value: InstanceValue, sequence: number) => void)[] = [];
  private failureListeners: (() => void)[] = [];
  constructor(initial: InstanceValue, sequence = SEQUENCE_ALREADY_LOADED) {
    this.value = initial;
    this.sequence = sequence;
  }
  subscribe(subscriber: (value: InstanceValue, sequence: number) => void) {
    this.subscribers.push(subscriber);
    return { dispose: () => { this.subscribers = this.subscribers.filter((s) => s !== subscriber); } };
  }
  publish(value: InstanceValue): void {
    this.value = value;
    this.readFailure = undefined;
    this.sequence++;
    for (const subscriber of [...this.subscribers]) subscriber(value, this.sequence);
  }
  onReadFailure(listener: () => void) {
    this.failureListeners.push(listener);
    return { dispose: () => { this.failureListeners = this.failureListeners.filter((l) => l !== listener); } };
  }
  fail(reason: string): void {
    this.readFailure = reason;
    for (const listener of [...this.failureListeners]) listener();
  }
}

const explicitFailureIfNotSettledWithin = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`getChildren() did not settle within ${ms} ms`)), ms)),
]);

const makeProvider = (
  mods: ModlistEntry[],
  extra: Partial<{ instance: FakeInstance }> = {},
) => new ModListProvider({ instance: extra.instance ?? new FakeInstance(valueOf(mods)) });

const orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt = ():ModlistEntry[] => [
  mod('Late Tweak'),
  mod('Early Fix', false),
  sep('Late Section'),
  mod('Base Patch'),
  sep('Early Section'),
  mod('Old Mod'),
  mod('Oldest Mod'),
];

const labelOf = (n: ModlistNode): string => (typeof n.label === 'string' ? n.label : n.label?.label ?? '');
const rowsOf = (nodes: readonly ModlistNode[]) => nodes.map((n) => `${n.kind} ${labelOf(n)}`);

describe('the tree reads as mod order', () => {
  it('losing at the top: the ungrouped mods, then the separators, then Overwrite last', async () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());

    expect(rowsOf(await provider.getChildren())).toEqual([
      'mod Oldest Mod', 'mod Old Mod', 'separator Early Section', 'separator Late Section', 'overwrite Overwrite',
    ]);
  });

  it('winning at the top: Overwrite first, then the separators, then the ungrouped mods', async () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
    provider.setViewDirection('winningAtTop');

    expect(rowsOf(await provider.getChildren())).toEqual([
      'overwrite Overwrite', 'separator Late Section', 'separator Early Section', 'mod Old Mod', 'mod Oldest Mod',
    ]);
  });

  it('a separator\'s mods follow the direction', async () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
    const lateSection = async () => expectInstanceOf(
      (await provider.getChildren()).find((n) => n.label === 'Late Section'), SeparatorNode);

    expect(rowsOf(await provider.getChildren(await lateSection()))).toEqual(['mod Early Fix', 'mod Late Tweak']);
    provider.setViewDirection('winningAtTop');
    expect(rowsOf(await provider.getChildren(await lateSection()))).toEqual(['mod Late Tweak', 'mod Early Fix']);
  });
});

describe('a row\'s identity is its kind and its name', () => {
  it('a mod and a separator that share a name are two rows', async () => {
    const provider = makeProvider([mod('Armor'), sep('Armor')]);
    const roots = await provider.getChildren();
    const separator = expectInstanceOf(roots.find((n) => n.kind === 'separator'), SeparatorNode);
    const [modRow] = await provider.getChildren(separator);

    expect(present(modRow, 'the Armor mod').id).not.toBe(separator.id);
  });

  it('a new instance value leaves every row\'s identity as it was', async () => {
    const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
    const provider = makeProvider([], { instance });
    const idsOf = async () => (await provider.getChildren()).map((n) => n.id);
    const before = await idsOf();

    instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt(), { overwriteFiles: overwriteHolding(4) }));

    expect(await idsOf()).toEqual(before);
    expect(new Set(before).size).toBe(before.length);
  });
});

describe('a line modlist.txt repeats, which MO2 reads as nothing and VS Code could not render as two rows with one id', () => {
  const repeated = (): ModlistEntry[] => [mod('Armor'), sep('Gear'), mod('Armor', false), mod('Boots'), sep('Gear')];

  it('is read as MO2 reads it: the first line holds, and each repeat is not a row', async () => {
    const provider = makeProvider(repeated());
    const roots = await provider.getChildren();
    const gear = expectInstanceOf(roots.find((n) => n.kind === 'separator'), SeparatorNode);
    const children = await provider.getChildren(gear);

    expect(rowsOf(roots)).toEqual(['mod Boots', 'separator Gear', 'overwrite Overwrite']);
    expect(rowsOf(children)).toEqual(['mod Armor']);
    expect(expectInstanceOf(children[0], ModNode).checkboxState).toBe(TreeItemCheckboxState.Checked);
    expect(provider.description()).toBe('2 / 2');
  });
});

describe('a separator\'s expander', () => {
  const separatorRows = async (provider: ModListProvider) =>
    new Map((await provider.getChildren())
      .filter((n): n is SeparatorNode => n instanceof SeparatorNode)
      .map((n) => [labelOf(n), n.collapsibleState]));

  it('starts collapsed on a fresh view, and a separator with no mods has none', async () => {
    const provider = makeProvider([mod('Held'), sep('Full'), sep('Empty')]);

    expect(await separatorRows(provider)).toEqual(new Map([
      ['Empty', TreeItemCollapsibleState.None], ['Full', TreeItemCollapsibleState.Collapsed],
    ]));
  });

  it('is expanded while a filter shows only the separator\'s matching mods', async () => {
    const provider = makeProvider([mod('Armor Fix'), mod('Weapons'), sep('Gear'), mod('Armor Pack'), sep('Armory')]);
    provider.setFilter('armo', true);

    expect(await separatorRows(provider)).toEqual(new Map([
      ['Armory', TreeItemCollapsibleState.Collapsed], ['Gear', TreeItemCollapsibleState.Expanded],
    ]));
  });

  it('a separator whose name matches but holds no mods has none while filtering', async () => {
    const provider = makeProvider([sep('Armory')]);
    provider.setFilter('armo', true);

    expect(await separatorRows(provider)).toEqual(new Map([['Armory', TreeItemCollapsibleState.None]]));
  });
});

describe('what the view says of itself', () => {
  const NO_MODS = 'No mods or separators. Install Mod… or Create Empty Mod…, in the title bar\'s overflow menu, adds one.';

  it('describes the enabled mods over the listed mods, counting the whole list while a filter narrows it', () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
    provider.setFilter('late', true);

    expect(provider.description()).toBe('4 / 5');
  });

  it('says there are no mods or separators, and how to add one', () => {
    expect(makeProvider([]).viewMessage()).toBe(NO_MODS);
  });

  it('says nothing of an empty list while a separator alone is listed', () => {
    expect(makeProvider([sep('Only')]).viewMessage()).toBeUndefined();
  });

  it('says nothing before the first read lands, the value then being the empty sentinel', () => {
    const provider = makeProvider([], { instance: new FakeInstance(valueOf([]), SEQUENCE_NOT_READ_YET) });

    expect(provider.description()).toBeUndefined();
    expect(provider.viewMessage()).toBeUndefined();
  });

  it('says it shows the last good read, with the reason, when a later read fails, and not once a read lands', () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const provider = makeProvider([], { instance });
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    instance.fail('EACCES modlist.txt');

    expect(provider.viewMessage()).toBe('Showing the last good read: EACCES modlist.txt');
    expect(fired).toHaveLength(1);
    instance.publish(valueOf([mod('A')]));
    expect(provider.viewMessage()).toBeUndefined();
  });
});

describe('a row\'s parent, which VS Code\'s reveal walks up through getParent and a filter\'s expansion is', () => {
  it('is the separator that holds a mod, and nothing for a root', async () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
    const roots = await provider.getChildren();
    const lateSection = expectInstanceOf(roots.find((n) => labelOf(n) === 'Late Section'), SeparatorNode);
    const [earlyFix] = await provider.getChildren(lateSection);

    expect(provider.getParent(present(earlyFix, 'Early Fix'))?.id).toBe(lateSection.id);
    expect(roots.map((n) => provider.getParent(n))).toEqual(roots.map(() => undefined));
  });
});

describe('the row for an origin, which Go to mod reveals', () => {
  const modOf = (name: string) => ({ kind: 'mod', name }) as const;

  it('is a mod whose separator was never rendered, with that separator as its parent', () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
    const row = expectInstanceOf(provider.rowFor(modOf('Base Patch')), ModNode);

    expect(row.mod.name).toBe('Base Patch');
    expect(provider.getParent(row)).toMatchObject({ kind: 'separator', id: 'separator:Early Section' });
  });

  it('is a root mod with no parent', () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());

    expect(provider.getParent(expectInstanceOf(provider.rowFor(modOf('Old Mod')), ModNode))).toBeUndefined();
  });

  it('is the Overwrite row for the run-time output', () => {
    const provider = makeProvider([mod('A')]);

    expect(provider.rowFor({ kind: 'runtimeOutput' })).toBeInstanceOf(OverwriteNode);
  });

  it('is nothing for a mod the list does not hold', () => {
    expect(makeProvider([mod('A')]).rowFor(modOf('Gone'))).toBeUndefined();
  });

  it('is nothing for a mod the filter hides, and a root mod when grouping is off', () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
    provider.setFilter('old mod', false);

    expect(provider.rowFor(modOf('Base Patch'))).toBeUndefined();
    expect(provider.getParent(expectInstanceOf(provider.rowFor(modOf('Old Mod')), ModNode))).toBeUndefined();
  });

  it('is a mod a matching separator shows whole, though the mod\'s own name does not match', () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
    provider.setFilter('early section', true);

    expect(provider.getParent(expectInstanceOf(provider.rowFor(modOf('Base Patch')), ModNode)))
      .toMatchObject({ id: 'separator:Early Section' });
    expect(provider.rowFor(modOf('Old Mod'))).toBeUndefined();
  });

  it('under a grouping filter has the separator its filter shows for it as its parent', () => {
    const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
    provider.setFilter('base', true);

    expect(provider.getParent(expectInstanceOf(provider.rowFor(modOf('Base Patch')), ModNode)))
      .toMatchObject({ id: 'separator:Early Section' });
    expect(provider.rowFor(modOf('Old Mod'))).toBeUndefined();
  });
});

describe('a click on a separator, a mod, Overwrite or a folder only selects', () => {
  it('none of those rows carries a command', async () => {
    const entries = [mod('Nexus Mod', true, { nexusId: '42' }), sep('Section'), mod('Loose')];
    const provider = makeProvider([], { instance: new FakeInstance(instanceValueFixture({
      ...valueOf(entries, { overwriteFiles: overwriteHolding(5) }),
      overwriteFolders: [{ relativePath: 'F4SE', path: '/instance/overwrite/F4SE', excluded: false }],
    })) });
    const roots = await provider.getChildren();
    const children = await Promise.all(roots.map((n) => provider.getChildren(n)));
    const rows = [...roots, ...children.flat()];

    expect(rows.map((n) => n.kind).sort()).toEqual(['folder', 'mod', 'mod', 'overwrite', 'separator']);
    expect(rows.filter((n) => n.command !== undefined)).toEqual([]);
  });
});

describe('ModListProvider', () => {
  it('rows exactly match the fixture value rather than a read of the provider\'s own, in file order reversed for the default losing-at-top view', async () => {
    const provider = makeProvider([mod('Zed'), mod('Aardvark')]);
    const roots = await provider.getChildren();
    const labels = roots.filter((n): n is ModNode => n instanceof ModNode).map((n) => n.label);
    expect(labels).toEqual(['Aardvark', 'Zed']);
  });

  it('renders no row for a folder in mods/ with no modlist line, since mod sync is what adds a line', async () => {
    const value = { ...valueOf([mod('Listed')]), modFolders: [
      { kind: 'mod', name: 'Listed', path: '/instance/mods/Listed' },
      { kind: 'mod', name: 'Dropped In', path: '/instance/mods/Dropped In' },
    ] } as InstanceValue;
    const provider = makeProvider([], { instance: new FakeInstance(value) });

    const labels = (await provider.getChildren()).map((n) => n.label);

    expect(labels).toContain('Listed');
    expect(labels).not.toContain('Dropped In');
  });

  it('returns a separator’s mods, the entries preceding it, as ModNodes with checkbox, version, tooltip, the later file entry first in the default losing-at-top view', async () => {
    const provider = makeProvider([
      mod('UFO4P', true, { version: 'v2.1.5', nexusId: '4598', archiveFilename: 'UFO4P.7z' }),
      mod('Disabled Mod', false),
      sep('Section'),
    ]);
    const roots = await provider.getChildren();
    const separator = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode), "the sole SeparatorNode");
    const children = await provider.getChildren(separator);

    expect(children).toHaveLength(2);
    const modNodes = expectInstancesOf(children, ModNode);
    const disabled = present(modNodes[0], 'the disabled mod row');
    const enabled = present(modNodes[1], 'the enabled mod row');
    expect(enabled.label).toBe('UFO4P');
    expect(enabled.description).toBe('v2.1.5');
    expect(enabled.checkboxState).toBe(TreeItemCheckboxState.Checked);
    expect(enabled.tooltip).toBe('UFO4P · v2.1.5 · 4598 · UFO4P.7z');
    expect(disabled.checkboxState).toBe(TreeItemCheckboxState.Unchecked);
    expect(disabled.tooltip).toBe('Disabled Mod');
  });

  it('a mod row states its enabled state and whether it has a Nexus id in its contextValue, which the mod-menu when clauses read to offer enable or disable and view on Nexus', async () => {
    const provider = makeProvider([
      mod('UFO4P', true, { nexusId: '4598' }),
      mod('Disabled Mod', false),
    ]);
    const rows = (await provider.getChildren()).filter((n): n is ModNode => n instanceof ModNode);
    const enabled = present(rows.find((n) => n.mod.name === 'UFO4P'), 'the enabled row');
    const disabled = present(rows.find((n) => n.mod.name === 'Disabled Mod'), 'the disabled row');

    expect(enabled.contextValue).toBe('mod hasNexus enabled untracked');
    expect(disabled.contextValue).toBe('mod disabled untracked');
  });

  it('a mod row states in its contextValue whether the instance value holds a plugin of it, and whether it has no repository, which track reads on a mod with a plugin and no repository', async () => {
    const value = instanceValueFixture({
      mods: [mod('Patch'), mod('Textures'), mod('Tracked')],
      trackedMods: new Set(['Tracked']),
      plugins: [
        { name: 'Patch.esp', origin: 'Patch', path: '/instance/mods/Patch/Patch.esp', slot: 0, enabled: true, winning: true },
        { name: 'Tracked.esp', origin: 'Tracked', path: '/instance/mods/Tracked/Tracked.esp', slot: 1, enabled: true, winning: true },
      ],
    });
    const rows = (await makeProvider([], { instance: new FakeInstance(value) }).getChildren())
      .filter((n): n is ModNode => n instanceof ModNode);

    expect(rows.map((n) => [n.mod.name, n.contextValue])).toEqual([
      ['Tracked', 'mod enabled holdsPlugin'],
      ['Textures', 'mod enabled untracked'],
      ['Patch', 'mod enabled holdsPlugin untracked'],
    ]);
  });

  it('a mod row states in its contextValue whether the mod has a file order conflict, which open conflicts reads', async () => {
    const value = await indexedValueOf([mod('High'), mod('Low'), mod('Apart'), mod('Off', false)], {
      High: { files: [file('High', 'a.dds')] },
      Low: { files: [file('Low', 'a.dds')] },
      Apart: { files: [file('Apart', 'b.dds')] },
      Off: { files: [file('Off', 'a.dds')] },
    });
    const rows = (await makeProvider([], { instance: new FakeInstance(value) }).getChildren())
      .filter((n): n is ModNode => n instanceof ModNode);

    expect(rows.map((n) => [n.mod.name, n.contextValue])).toEqual([
      ['Off', 'mod disabled untracked'],
      ['Apart', 'mod enabled untracked'],
      ['Low', 'mod enabled untracked fileOrderConflict'],
      ['High', 'mod enabled untracked fileOrderConflict'],
    ]);
  });

  it('a mod that shares a file with Overwrite alone has a file order conflict', async () => {
    const value = await indexedValueOf([mod('Shares'), mod('Apart')], {
      Shares: { files: [file('Shares', 'a.log')] },
      Apart: { files: [file('Apart', 'b.dds')] },
    }, { files: [file('overwrite', 'a.log')] });
    const rows = (await makeProvider([], { instance: new FakeInstance(value) }).getChildren())
      .filter((n): n is ModNode => n instanceof ModNode);

    expect(rows.map((n) => [n.mod.name, n.contextValue])).toEqual([
      ['Apart', 'mod enabled untracked'],
      ['Shares', 'mod enabled untracked fileOrderConflict'],
    ]);
  });

  it('hands the driving lib its mod from a mod row, and none from a separator or the Overwrite row', async () => {
    const provider = makeProvider([mod('Patch'), sep('Tools')]);
    const roots = await provider.getChildren();
    const separator = present(roots.find((n) => n instanceof SeparatorNode), 'the separator row');
    const patch = present((await provider.getChildren(separator)).concat(roots).find((n) => n instanceof ModNode), 'the mod row');
    const overwrite = present(roots.find((n) => n instanceof OverwriteNode), 'the Overwrite row');

    expect(modOfRow(patch)).toBe('Patch');
    expect(modOfRow(separator)).toBeUndefined();
    expect(modOfRow(overwrite)).toBeUndefined();
  });

  it('re-renders on a second, later value published after construction, not only the value handed to the constructor', async () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const provider = makeProvider([], { instance });
    const first = await provider.getChildren();
    expect(first.filter((n): n is ModNode => n instanceof ModNode).map((n) => n.label)).toEqual(['A']);

    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    instance.publish(valueOf([mod('A'), mod('B')]));

    expect(fired).toBe(true);
    const second = await provider.getChildren();
    expect(second.filter((n): n is ModNode => n instanceof ModNode).map((n) => n.label)).toEqual(['B', 'A']);
  });

  it('renders no rows before the first read, and the read\'s rows once it lands', async () => {
    await withUnreadCorpusInstance(async (instance) => {
      const provider = new ModListProvider({ instance });

      const pending = provider.getChildren();
      await instance.refresh();
      const rendered = (await pending).map((n) => n.label);

      expect(rendered.length).toBeGreaterThan(1);
      expect(rendered).toEqual((await provider.getChildren()).map((n) => n.label));
      provider.dispose();
    });
  });

  it('settles a failed first read, rather than spinning forever, on the one error row naming the reason, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), SEQUENCE_NOT_READ_YET);
    const provider = makeProvider([], { instance });

    const pending = provider.getChildren();
    instance.fail('EACCES: permission denied, open modlist.txt');
    const rows = await explicitFailureIfNotSettledWithin(pending, 500);

    expect(rows).toHaveLength(1);
    const error = expectInstanceOf(rows[0], ErrorNode);
    expect(error.label).toBe('Failed to load: EACCES: permission denied, open modlist.txt');
    expect(error.tooltip).toBe('EACCES: permission denied, open modlist.txt');
    expect(error.iconPath).toEqual(new ThemeIcon('error'));

    instance.publish(valueOf([mod('A')]));
    const after = await explicitFailureIfNotSettledWithin(provider.getChildren(), 500);

    expect(after.some((n) => n instanceof ModNode)).toBe(true);
    expect(after.some((n) => n instanceof ErrorNode)).toBe(false);
  });

  it('renders a genuinely empty modlist immediately, as the Overwrite row alone, when the first landed value already carries none', async () => {
    const provider = makeProvider([], { instance: new FakeInstance(valueOf([]), SEQUENCE_ALREADY_LOADED) });
    expect(rowsOf(await provider.getChildren())).toEqual(['overwrite Overwrite']);
  });

  describe('setFilter — grouping on (default)', () => {
    const entries = (): ModlistEntry[] => [
      mod('Zeta'),
      mod('Alpha Child'),
      sep('Group A'),
      mod('Gamma'),
      sep('Group B'),
      mod('Alpha'),
      mod('Beta'),
    ];

    it('filter with groupingOn keeps an ungrouped match and a separator with a matching child, and hides a non-match and a separator holding only non-matches', async () => {
      const provider = makeProvider(entries());
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();

      const labels = roots.map((n) => n.label);
      expect(labels).toContain('Alpha');
      expect(labels).not.toContain('Beta');
      expect(labels).toContain('Group A');
      expect(labels).not.toContain('Group B');
    });

    it('filter with groupingOn shows only matching children under separator', async () => {
      const provider = makeProvider(entries());
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();
      const sepNode = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode), "the sole SeparatorNode");
      const children = await provider.getChildren(sepNode);

      expect(children.map((n) => n.label)).toEqual(['Alpha Child']);
    });

    it('separator name match causes all its children to be shown, including Zeta which would not match alone, in the reversed losing-at-top order', async () => {
      const provider = makeProvider(entries());
      provider.setFilter('group a', true);
      const roots = await provider.getChildren();
      const sepNode = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode), "the sole SeparatorNode");
      expect(sepNode.label).toBe('Group A');
      const children = await provider.getChildren(sepNode);
      expect(children.map((n) => n.label)).toEqual(['Alpha Child', 'Zeta']);
    });

    it('fires onDidChangeTreeData when filter is set', () => {
      const provider = makeProvider(entries());
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });
      provider.setFilter('x', true);
      expect(fired).toBe(true);
    });

    it('setFilter does not rebuild rows, re-rendering the stale cache built off the original 7-entry fixture rather than re-pulling the instance value', async () => {
      const instance = new FakeInstance(valueOf(entries()));
      const provider = makeProvider([], { instance });
      await provider.getChildren();

      instance.value = valueOf([mod('Alpha')]);
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();

      expect(roots.map((n) => n.label)).toContain('Group A');
    });
  });

  describe('setFilter — grouping off', () => {
    const entries = [
      mod('Alpha'),
      sep('Group A'),
      mod('Alpha Child'),
      mod('Gamma'),
      sep('Group B'),
      mod('Delta'),
    ] satisfies ModlistEntry[];

    it('flat list: only matching mods, no separators, and Overwrite', async () => {
      const provider = makeProvider(entries);
      provider.setFilter('alpha', false);

      expect(rowsOf(await provider.getChildren())).toEqual(['mod Alpha Child', 'mod Alpha', 'overwrite Overwrite']);
    });
  });

  describe('drag-and-drop', () => {
    const token = new FakeCancellationToken();
    const MIME = 'application/vnd.medit.modlist-node';

    const dndEntriesWhereASeparatorWrapsTheEntriesThatPrecedeIt: ModlistEntry[] = [
      mod('Alpha'), sep('Group A'), mod('Beta'), mod('Gamma'), sep('Group B'), mod('Delta'),
    ];

    async function shownRows(provider: ModListProvider): Promise<ModlistNode[]> {
      const rows: ModlistNode[] = [];
      for (const root of await provider.getChildren()) {
        rows.push(root);
        if (root instanceof SeparatorNode) rows.push(...await provider.getChildren(root));
      }
      return rows;
    }
    const rowLabelled = (rows: readonly ModlistNode[], label: string): ModlistNode =>
      present(rows.find((row) => labelOf(row) === label), `the '${label}' row`);

    async function dragAndDrop(provider: ModListProvider, dragged: readonly string[], target: string | undefined): Promise<void> {
      const rows = await shownRows(provider);
      const dataTransfer = new DataTransfer();
      provider.handleDrag(dragged.map((label) => rowLabelled(rows, label)), dataTransfer, token);
      await provider.handleDrop(target === undefined ? undefined : rowLabelled(rows, target), dataTransfer, token);
    }

    const movesFired = () => executeCommand.mock.calls.filter(([id]) => id === 'modbench.mod.move');
    const argumentLabels = (call: readonly unknown[]): string[] => (Array.isArray(call[2]) ? call[2] : [])
      .filter((row): row is ModNode | SeparatorNode => row instanceof ModNode || row instanceof SeparatorNode).map(labelOf);

    it('a drop fires move with every dragged row as its Argument, and the place the view shows it landing', async () => {
      const provider = makeProvider(dndEntriesWhereASeparatorWrapsTheEntriesThatPrecedeIt);

      await dragAndDrop(provider, ['Alpha', 'Delta'], 'Gamma');

      const rows = await shownRows(provider);
      const argument = [rowLabelled(rows, 'Alpha'), rowLabelled(rows, 'Delta')];
      expect(movesFired()).toEqual([[
        'modbench.mod.move', argument[0], argument, { place: { kind: 'mod', name: 'Gamma' }, end: 'losing' },
      ]]);
    });

    it('a drop follows the view\'s sort direction', async () => {
      const provider = makeProvider(dndEntriesWhereASeparatorWrapsTheEntriesThatPrecedeIt);
      provider.setViewDirection('winningAtTop');

      await dragAndDrop(provider, ['Group B'], undefined);

      expect(movesFired().map((call) => call[3])).toEqual([{ place: { kind: 'modOrder' }, end: 'losing' }]);
    });

    it('a drag that mixes kinds takes the kind of the row VS Code last added to the selection', async () => {
      const provider = makeProvider(dndEntriesWhereASeparatorWrapsTheEntriesThatPrecedeIt);

      await dragAndDrop(provider, ['Group B', 'Delta'], 'Group A');
      await dragAndDrop(provider, ['Delta', 'Group B'], 'Group A');

      expect(movesFired().map(argumentLabels)).toEqual([['Delta'], ['Group B']]);
    });

    it('a drop where what is dragged cannot go fires nothing', async () => {
      const provider = makeProvider(dndEntriesWhereASeparatorWrapsTheEntriesThatPrecedeIt);

      await dragAndDrop(provider, ['Delta'], 'Overwrite');
      await dragAndDrop(provider, ['Alpha', 'Delta'], 'Alpha');
      await dragAndDrop(provider, ['Group B'], 'Delta');

      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('Overwrite is carried by no drag', async () => {
      const provider = makeProvider(dndEntriesWhereASeparatorWrapsTheEntriesThatPrecedeIt);
      const rows = await shownRows(provider);
      const dataTransfer = new DataTransfer();

      provider.handleDrag([rowLabelled(rows, 'Delta'), rowLabelled(rows, 'Overwrite')], dataTransfer, token);
      await provider.handleDrop(rowLabelled(rows, 'Gamma'), dataTransfer, token);

      expect(movesFired().map(argumentLabels)).toEqual([['Delta']]);
    });

    it('nothing from outside the view drops here', async () => {
      const provider = makeProvider(dndEntriesWhereASeparatorWrapsTheEntriesThatPrecedeIt);
      const rows = await shownRows(provider);
      const dataTransfer = new DataTransfer();
      dataTransfer.set(MIME, new DataTransferItem({ kind: 'mod', name: 'Delta' }));
      dataTransfer.set('text/uri-list', new DataTransferItem('file:///downloads/SomeMod.7z'));

      await provider.handleDrop(rowLabelled(rows, 'Gamma'), dataTransfer, token);

      expect(provider.dropMimeTypes).toEqual([MIME]);
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('a drop asks for no refresh, since a drop moves no row on screen', async () => {
      const provider = makeProvider(dndEntriesWhereASeparatorWrapsTheEntriesThatPrecedeIt);
      await shownRows(provider);
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });

      await dragAndDrop(provider, ['Delta'], 'Group A');

      expect(movesFired()).toHaveLength(1);
      expect(fired).toBe(false);
    });
  });

  describe('setFilter — reset behaviour', () => {
    it('clearing filter resets groupingOn to true when grouping off is passed with the cleared text, and shows all nodes', async () => {
      const provider = makeProvider([sep('Sep'), mod('Mod')]);
      provider.setFilter('x', false);
      provider.setFilter('', false);
      const roots = await provider.getChildren();
      expect(roots.some((n) => n instanceof SeparatorNode)).toBe(true);
    });
  });

  describe('view direction', () => {
    it('default view renders the losing end (last file entry) at the top, the sibling list reversed from the winning-first file order', async () => {
      const provider = makeProvider([mod('Winning'), mod('Middle'), mod('Losing')]);
      const roots = await provider.getChildren();
      expect(roots.filter((n): n is ModNode => n instanceof ModNode).map((n) => n.label))
        .toEqual(['Losing', 'Middle', 'Winning']);
    });
  });

  describe('sort order toggle', () => {
    it('setting the view direction fires a refresh', () => {
      const provider = makeProvider([mod('A')]);
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });

      provider.setViewDirection('winningAtTop');

      expect(fired).toBe(true);
    });

    it('toggled to winning-at-top: the mods within a separator, the entries preceding it, are in file order', async () => {
      const provider = makeProvider([
        mod('First'),
        mod('Second'),
        mod('Third'),
        sep('Section'),
      ]);
      provider.setViewDirection('winningAtTop');
      const roots = await provider.getChildren();
      const sepNode = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode), "the sole SeparatorNode");
      const children = await provider.getChildren(sepNode);

      expect(children.map((n) => n.label)).toEqual(['First', 'Second', 'Third']);
    });

    it('the direction applies to the flat list', async () => {
      const provider = makeProvider([
        mod('Alpha'),
        sep('Group A'),
        mod('Alpha Child'),
        mod('Alpha Other'),
      ]);
      provider.setViewDirection('winningAtTop');
      provider.setFilter('alpha', false);
      const roots = await provider.getChildren();

      expect(rowsOf(roots)).toEqual(['overwrite Overwrite', 'mod Alpha', 'mod Alpha Child', 'mod Alpha Other']);
    });

    it('the direction applies to the grouped, filtered list', async () => {
      const provider = makeProvider([
        mod('Alpha Child'),
        mod('Alpha Other'),
        sep('Group A'),
        mod('Alpha'),
      ]);
      provider.setViewDirection('winningAtTop');
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();

      expect(rowsOf(roots)).toEqual(['overwrite Overwrite', 'separator Group A', 'mod Alpha']);
      const sepNode = expectInstanceOf(roots[1], SeparatorNode);
      const children = await provider.getChildren(sepNode);
      expect(children.map((n) => n.label)).toEqual(['Alpha Child', 'Alpha Other']);
    });
  });

  describe('a mod row, whatever files it wins or loses (mods.md, A row, Mod)', () => {
    const contested = () => indexedValueOf(
      [mod('Winner'), mod('Loser', true, { version: '1.2', nexusId: '42', archiveFilename: 'loser.7z' })],
      { Winner: { files: [file('Winner', 'a.dds')] }, Loser: { files: [file('Loser', 'a.dds'), file('Loser', 'b.dds')] } },
    );
    const rowOf = async (name: string) => {
      const provider = makeProvider([], { instance: new FakeInstance(await contested()) });
      return present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.mod.name === name), `the '${name}' row`);
    };

    it('shows $(package), the version as its description, and a tooltip of name, version, Nexus mod ID and installation file', async () => {
      const loser = await rowOf('Loser');

      expect([loser.iconPath, loser.description, loser.tooltip]).toEqual([{ id: 'package' }, '1.2', 'Loser · 1.2 · 42 · loser.7z']);
    });

    it('carries a URI of its own, on no file: scheme, for its indicators to decorate', async () => {
      const [winner, loser] = [present((await rowOf('Winner')).resourceUri, 'its URI'), present((await rowOf('Loser')).resourceUri, 'its URI')];

      expect([typeof winner.scheme, winner.scheme === 'file']).toEqual(['string', false]);
      expect(winner).not.toEqual(loser);
    });
  });

  describe('Overwrite row, pinned outside separator grouping, over the value\'s own files', () => {
    const entries = (): ModlistEntry[] => [mod('Alpha'), sep('Group A'), mod('Beta')];
    const overwriteRow = async (fileCount: number) => {
      const provider = makeProvider([], { instance: new FakeInstance(valueOf(entries(), { overwriteFiles: overwriteHolding(fileCount) })) });
      return expectInstanceOf((await provider.getChildren()).find((n) => n instanceof OverwriteNode), OverwriteNode);
    };

    it('holding files: its count as the description and a tinted folder icon', async () => {
      const row = await overwriteRow(3);

      expect(row.label).toBe('Overwrite');
      expect(row.description).toBe('3');
      expect(row.iconPath).toEqual(new ThemeIcon('folder', new ThemeColor('charts.red')));
    });

    it('holding nothing: still a row, with no description and an untinted folder icon', async () => {
      const row = await overwriteRow(0);

      expect(row.label).toBe('Overwrite');
      expect(row.description).toBeUndefined();
      expect(row.iconPath).toEqual(new ThemeIcon('folder'));
    });

    it('says what Overwrite is, and nothing of deploy', async () => {
      const row = await overwriteRow(2);

      expect(row.tooltip).toBe('The files tools wrote while MO2 ran them, which win over every mod.');
    });

    it('names the mod manager the value names, not MO2 over another manager\'s instance', async () => {
      const provider = makeProvider([], { instance: new FakeInstance(valueOf(entries(), { managerNames: { manager: 'Another Manager', modOrderFile: 'order.txt', downloadMetadataFile: 'order.sidecar' } })) });
      const row = expectInstanceOf((await provider.getChildren()).find((n) => n instanceof OverwriteNode), OverwriteNode);

      expect(row.tooltip).toBe('The files tools wrote while Another Manager ran them, which win over every mod.');
    });

    it('is not a mod: no check box, no click, no resourceUri (which would hand the label to every file decoration provider, git\'s included), and its own menu', async () => {
      const row = await overwriteRow(2);

      expect(row.checkboxState).toBeUndefined();
      expect(row.command).toBeUndefined();
      expect(row.resourceUri).toBeUndefined();
      expect(row.contextValue).toBe('overwrite');
    });

    it('cannot be dragged', async () => {
      const row = await overwriteRow(2);
      const provider = makeProvider(entries());
      const dataTransfer = new DataTransfer();

      provider.handleDrag([row], dataTransfer, new FakeCancellationToken());

      expect(dataTransfer.get('application/vnd.medit.modlist-node')).toBeUndefined();
    });
  });
});
