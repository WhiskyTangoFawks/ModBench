import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mod, ModlistEntry, Separator } from '../../instanceLoader/instance';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { ModStatusResult } from '../../instanceLoader/statusChecker';
import { present } from '../../ports/present';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, DataTransferItem, DataTransfer, FakeCancellationToken,
} from '../../test/vscodeMock';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import type { setModsEnabled } from '../../modlist/modlist';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn((_id: string, ..._args: unknown[]) => Promise.resolve()) }));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  commands: { executeCommand },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
}));

const { setModsEnabledMock } = vi.hoisted(() => ({
  setModsEnabledMock: vi.fn<typeof setModsEnabled>(),
}));
vi.mock('../../modlist/modlist', () => ({
  setModsEnabled: (...args: Parameters<typeof setModsEnabledMock>) => setModsEnabledMock(...args),
}));

import { ModListProvider, SeparatorNode, ModNode, OverwriteNode, modOfRow, type ModlistNode } from '../ModListProvider';
import { ErrorNode } from '../errorNode';
import { onModCheckboxChanged } from '../modCheckboxHandler';
import { recordingReporter } from '../../test/surfacingDoubles';
import { withUnreadCorpusInstance } from '../../test/mo2/unreadCorpusInstance';
import { expectInstanceOf, expectInstancesOf } from '../../test/expectInstanceOf';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { accessTo } from '../../test/mo2/adapterOver';

const INSTANCE_ROOT = '/instance';
const ACTIVE_PROFILE = 'Default';

beforeEach(() => {
  setModsEnabledMock.mockReset();
  setModsEnabledMock.mockResolvedValue({ applied: true, outcome: { landed: [], refused: [] } });
  executeCommand.mockClear();
});

const mod = (name: string, enabled = true, extra: Partial<Mod> = {}): Mod => ({
  kind: 'mod', name, enabled, ...extra,
});
const sep = (name: string, enabled = false): Separator => ({ kind: 'separator', name, enabled });

function valueOf(
  mods: ModlistEntry[],
  extra: Partial<Pick<InstanceValue, 'activeProfile' | 'modStatuses' | 'overwriteFileCount' | 'paths' | 'managerNames' | 'modFolders'>> = {},
): InstanceValue {
  return instanceValueFixture({
    mods,
    activeProfile: extra.activeProfile ?? ACTIVE_PROFILE,
    modStatuses: extra.modStatuses ?? new Map<string, ModStatusResult>(),
    overwriteFileCount: extra.overwriteFileCount ?? 0,
    ...(extra.paths ? { paths: extra.paths } : {}),
    ...(extra.managerNames ? { managerNames: extra.managerNames } : {}),
    ...(extra.modFolders ? { modFolders: extra.modFolders } : {}),
  });
}

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

const explicitFailureIfNotSettledWithin =<T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`getChildren() did not settle within ${ms} ms`)), ms)),
]);

const makeProvider = (
  mods: ModlistEntry[],
  extra: Partial<{ instance: FakeInstance; instanceRoot: string; log: (line: string) => void }> = {},
) => new ModListProvider({
  instance: extra.instance ?? new FakeInstance(valueOf(mods)),
  access: accessTo(extra.instanceRoot ?? INSTANCE_ROOT),
  log: extra.log ?? (() => undefined),
});

const orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt =(): ModlistEntry[] => [
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

    instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt(), { overwriteFileCount: 4 }));

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

    expect(provider.getParent(present(earlyFix, 'Early Fix'))).toBe(lateSection);
    expect(roots.map((n) => provider.getParent(n))).toEqual(roots.map(() => undefined));
  });
});

describe('a click only selects', () => {
  it('no row carries a command', async () => {
    const entries = [mod('Nexus Mod', true, { nexusId: '42' }), sep('Section'), mod('Loose')];
    const provider = makeProvider([], { instance: new FakeInstance(valueOf(entries, { overwriteFileCount: 5 })) });
    const roots = await provider.getChildren();
    const children = await Promise.all(roots.map((n) => provider.getChildren(n)));
    const rows = [...roots, ...children.flat()];

    expect(rows.map((n) => n.kind).sort()).toEqual(['mod', 'mod', 'overwrite', 'separator']);
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

  it('names the mod a mod row stands for, and no mod for any other row or value', async () => {
    const provider = makeProvider([mod('Patch'), sep('Tools')]);
    const roots = await provider.getChildren();
    const separator = present(roots.find((n) => n instanceof SeparatorNode), 'the separator row');
    const rows = [...roots, ...await provider.getChildren(separator)];
    const patch = present(rows.find((n) => n instanceof ModNode), 'the mod row');
    const overwrite = present(roots.find((n) => n instanceof OverwriteNode), 'the Overwrite row');

    expect(modOfRow(patch)).toBe('Patch');
    expect(modOfRow(separator)).toBeUndefined();
    expect(modOfRow(overwrite)).toBeUndefined();
    expect(modOfRow({ kind: 'mod', mod: { name: 'Patch' } })).toBeUndefined();
    expect(modOfRow(undefined)).toBeUndefined();
  });

  it('setModEnabled calls the setModsEnabled command, as a context-menu click or key does, with the access, active profile and one-mod selection, and fires no refresh since the watch brings the landed write back', async () => {
    const access = accessTo(INSTANCE_ROOT);
    const provider = new ModListProvider({ instance: new FakeInstance(valueOf([mod('A')])), access, log: () => undefined });
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await provider.setModEnabled('A', false);

    expect(setModsEnabledMock).toHaveBeenCalledWith(access, ACTIVE_PROFILE, ['A'], false);
    expect(fired).toBe(false);
  });

  it('setModEnabled throws when the command globally refuses, so the checkbox handler has one failure path, and fires no refresh', async () => {
    setModsEnabledMock.mockResolvedValue({ applied: false, refusal: 'nope' });
    const provider = makeProvider([mod('A')]);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await expect(provider.setModEnabled('A', false)).rejects.toThrow('nope');
    expect(fired).toBe(false);
  });

  it('setModEnabled throws the per-item refusal when the one mod it asked for comes back refused in an otherwise-applied outcome', async () => {
    setModsEnabledMock.mockResolvedValue({
      applied: true, outcome: { landed: [], refused: [{ item: 'A', reason: 'Mod not found in modlist: A' }] },
    });
    const provider = makeProvider([mod('A')]);

    await expect(provider.setModEnabled('A', false)).rejects.toThrow('Mod not found in modlist: A');
  });

  it('a check box whose write is refused returns to what the disk says, and says why', async () => {
    setModsEnabledMock.mockResolvedValue({
      applied: true, outcome: { landed: [], refused: [{ item: 'A', reason: 'Mod not found in modlist: A' }] },
    });
    const provider = makeProvider([mod('A')]);
    const row = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode), 'the A row');
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    const reporter = recordingReporter();

    await onModCheckboxChanged({ items: [[row, TreeItemCheckboxState.Unchecked]] }, provider, reporter);

    expect(fired).toBe(true);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to update "A".', detail: 'Mod not found in modlist: A' },
    ]);
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
    await withUnreadCorpusInstance(async (instance, root) => {
      const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });

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

    it('a drop asks for no refresh, since a drop moves no row on screen and the watch brings the write back', async () => {
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
    it('clearing filter resets groupingOn to true whatever grouping is passed with the cleared text, and shows all nodes', async () => {
      const provider = makeProvider([sep('Sep'), mod('Mod')]);
      provider.setFilter('x', false);
      provider.setFilter('', false);
      const roots = await provider.getChildren();
      expect(roots.some((n) => n instanceof SeparatorNode)).toBe(true);
    });
  });

  describe('view direction', () => {
    it('default view renders the losing end (last file entry) at the top, as MO2 does, so a sibling list renders reversed from the winning-first file order', async () => {
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

  describe('status badges, straight off instance.value.modStatuses with no disk read', () => {
    const conflictStatuses = (): Map<string, ModStatusResult> => new Map([
      ['ModA', { status: { kind: 'conflicts', count: 1 }, conflictLines: ['textures/shared/foo.dds → winner: ModB'] }],
      ['ModB', { status: { kind: 'overrides', count: 1 }, conflictLines: ['textures/shared/foo.dds → winner: ModB'] }],
    ]);

    it('attaches a warning icon and conflict tooltip line to conflicted mods', async () => {
      const provider = makeProvider([mod('ModA'), mod('ModB')], {
        instance: new FakeInstance(valueOf([mod('ModA'), mod('ModB')], { modStatuses: conflictStatuses() })),
      });
      const roots = await provider.getChildren();
      const modNodes = roots.filter((n): n is ModNode => n instanceof ModNode);
      const modA = present(modNodes.find((n) => n.label === 'ModA'), "the 'ModA' node");
      const modB = present(modNodes.find((n) => n.label === 'ModB'), "the 'ModB' node");

      expect(modA.iconPath).toEqual({ id: 'warning' });
      expect(modA.tooltip).toContain('textures/shared/foo.dds');
      expect(modB.iconPath).toEqual({ id: 'warning' });
      expect(modB.tooltip).toContain('textures/shared/foo.dds');
    });

    it('keeps a conflicted mod\'s badge identical after filtering it in, and after clearing the filter, since a badge is a fixed field of the value and a filter only narrows already-built rows', async () => {
      const instance = new FakeInstance(valueOf([mod('ModA'), mod('ModB')], { modStatuses: conflictStatuses() }));
      const provider = makeProvider([], { instance });
      const before = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA'), "the 'ModA' node");

      provider.setFilter('moda', true);
      const filtered = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA'), "the 'ModA' node");
      expect(filtered.iconPath).toEqual(before.iconPath);
      expect(filtered.tooltip).toEqual(before.tooltip);
      expect(filtered.description).toEqual(before.description);

      provider.setFilter('', true);
      const cleared = await provider.getChildren();
      expect(cleared.filter((n): n is ModNode => n instanceof ModNode)).toHaveLength(2);
      const clearedModA = present(cleared.find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA'), "the 'ModA' node");
      expect(clearedModA.iconPath).toEqual(before.iconPath);
    });

    it('flipping the view direction and back leaves a conflict\'s winner, since view order is presentation-only and independent of override order', async () => {
      const instance = new FakeInstance(valueOf([mod('ModA'), mod('ModB')], { modStatuses: conflictStatuses() }));
      const provider = makeProvider([], { instance });
      const before = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA'), "the 'ModA' node");
      expect(before.tooltip).toContain('winner: ModB');

      provider.setViewDirection('winningAtTop');
      const afterFlip = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA'), "the 'ModA' node");
      expect(afterFlip.tooltip).toContain('winner: ModB');
      expect(afterFlip.iconPath).toEqual(before.iconPath);

      provider.setViewDirection('losingAtTop');
      const afterFlipBack = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA'), "the 'ModA' node");
      expect(afterFlipBack.tooltip).toContain('winner: ModB');
    });

    it('a mod absent from modStatuses (or explicitly ok) renders the default icon, no badge text', async () => {
      const provider = makeProvider([mod('ModA'), mod('ModB')], {
        instance: new FakeInstance(valueOf([mod('ModA'), mod('ModB')], {
          modStatuses: new Map([['ModB', { status: { kind: 'ok' }, conflictLines: [] }]]),
        })),
      });
      const roots = await provider.getChildren();
      const modA = present(roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA'), "the 'ModA' node");
      const modB = present(roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'ModB'), "the 'ModB' node");
      expect(modA.iconPath).toEqual({ id: 'package' });
      expect(modB.iconPath).toEqual({ id: 'package' });
    });

    it('renders the status badge exactly as given by the Instance value rather than computing it, the count of 7 and its path being unreachable from this fixture\'s data', async () => {
      const statuses = new Map<string, ModStatusResult>([
        ['ModA', { status: { kind: 'conflicts', count: 7 }, conflictLines: ['nonexistent/path.dds → winner: ModZ'] }],
      ]);
      const provider = makeProvider([mod('ModA')], {
        instance: new FakeInstance(valueOf([mod('ModA')], { modStatuses: statuses })),
      });
      const roots = await provider.getChildren();
      const modA = present(roots.find((n): n is ModNode => n instanceof ModNode), "the sole ModNode");

      expect(modA.iconPath).toEqual({ id: 'warning' });
      expect(modA.description).toContain('7 conflicts');
      expect(modA.tooltip).toContain('nonexistent/path.dds');
    });
  });

  describe('Overwrite row, a pinned leaf outside separator grouping, over the value\'s own count', () => {
    const entries = (): ModlistEntry[] => [mod('Alpha'), sep('Group A'), mod('Beta')];
    const overwriteRow = async (overwriteFileCount: number) => {
      const provider = makeProvider([], { instance: new FakeInstance(valueOf(entries(), { overwriteFileCount })) });
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
      const provider = makeProvider([], { instance: new FakeInstance(valueOf(entries(), { managerNames: { manager: 'Another Manager', modOrderFile: 'order.txt' } })) });
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

describe('an unconfirmed check box', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const rowNamed = async (provider: ModListProvider, name: string): Promise<ModNode> =>
    present((await provider.getChildren()).filter((n): n is ModNode => n instanceof ModNode).find((n) => n.mod.name === name), name);
  const iconId = (row: ModNode) => expectInstanceOf(row.iconPath, ThemeIcon).id;

  it('shows the new state at once, and the mark only after a delay, on that row alone', async () => {
    const provider = makeProvider([mod('A'), mod('B')]);

    provider.markUnconfirmed('A', false);
    expect((await rowNamed(provider, 'A')).checkboxState).toBe(TreeItemCheckboxState.Unchecked);
    expect(iconId(await rowNamed(provider, 'A'))).toBe('package');

    vi.advanceTimersByTime(1000);
    const marked = await rowNamed(provider, 'A');
    expect(iconId(marked)).toBe('sync~spin');
    expect(marked.tooltip).toBe('Written; waiting for the disk to confirm');
    expect(iconId(await rowNamed(provider, 'B'))).toBe('package');
  });

  it('keeps the mark, and says it shows the last good read, when a read fails while the write is unconfirmed', async () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const provider = makeProvider([], { instance });
    provider.markUnconfirmed('A', false);
    vi.advanceTimersByTime(1000);

    instance.fail('EACCES modlist.txt');

    expect(iconId(await rowNamed(provider, 'A'))).toBe('sync~spin');
    expect(provider.viewMessage()).toBe('Showing the last good read: EACCES modlist.txt');
  });

  it('goes when the disk\'s next value lands, and never flickers when that is at once', async () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const provider = makeProvider([], { instance });
    provider.markUnconfirmed('A', false);

    instance.publish(valueOf([mod('A', false)]));
    vi.advanceTimersByTime(1000);

    expect(iconId(await rowNamed(provider, 'A'))).toBe('package');
  });

  it('keeps the mark through a pre-write value, and clears silently when the confirming one lands', async () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const logged: string[] = [];
    const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
    provider.markUnconfirmed('A', false);
    vi.advanceTimersByTime(1000);

    instance.publish(valueOf([mod('A', true)]));
    const held = await rowNamed(provider, 'A');
    expect(held.checkboxState).toBe(TreeItemCheckboxState.Unchecked);
    expect(iconId(held)).toBe('sync~spin');

    instance.publish(valueOf([mod('A', false)]));
    const confirmed = await rowNamed(provider, 'A');
    expect(confirmed.checkboxState).toBe(TreeItemCheckboxState.Unchecked);
    expect(iconId(confirmed)).toBe('package');
    expect(logged).toEqual([]);
  });

  it('shows the disk\'s value and says so once a second landed value still differs, with no notification', async () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const logged: string[] = [];
    const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
    provider.markUnconfirmed('A', false);
    vi.advanceTimersByTime(1000);

    instance.publish(valueOf([mod('A', true)]));
    instance.publish(valueOf([mod('A', true)]));

    expect((await rowNamed(provider, 'A')).checkboxState).toBe(TreeItemCheckboxState.Checked);
    expect(iconId(await rowNamed(provider, 'A'))).toBe('package');
    expect(logged).toEqual(['"A" was written disabled, and the disk now shows it enabled.']);
  });

  it('says nothing when the disk shows what was written', () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const logged: string[] = [];
    const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
    provider.markUnconfirmed('A', false);

    instance.publish(valueOf([mod('A', false)]));

    expect(logged).toEqual([]);
  });

  it('stays while the disk cannot be read', async () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const provider = makeProvider([], { instance });
    provider.markUnconfirmed('A', false);
    vi.advanceTimersByTime(1000);

    instance.fail('locked');

    expect(iconId(await rowNamed(provider, 'A'))).toBe('sync~spin');
  });

  it('stays when a refresh is refused, which lands no value', async () => {
    const provider = makeProvider([mod('A')]);
    provider.markUnconfirmed('A', false);
    vi.advanceTimersByTime(1000);

    expect(iconId(await rowNamed(provider, 'A'))).toBe('sync~spin');
  });

  it('goes with a refresh that lands, which reloads from disk', async () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const provider = makeProvider([], { instance });
    provider.markUnconfirmed('A', false);
    vi.advanceTimersByTime(1000);

    instance.publish(valueOf([mod('A', false)]));

    expect(iconId(await rowNamed(provider, 'A'))).toBe('package');
  });

  it('feeds the key context the written state while the write is unconfirmed', async () => {
    const provider = makeProvider([mod('A')]);
    provider.markUnconfirmed('A', false);

    expect(provider.isEnabled(await rowNamed(provider, 'A'))).toBe(false);
  });

  it('a write forgotten before its delay never shows the mark', async () => {
    const provider = makeProvider([mod('A')]);
    provider.markUnconfirmed('A', false);

    provider.forgetUnconfirmed('A');
    vi.advanceTimersByTime(1000);

    expect(iconId(await rowNamed(provider, 'A'))).toBe('package');
  });
});

describe('an unconfirmed separator rename (common.md, Unconfirmed writes)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const separators = async (provider: ModListProvider): Promise<SeparatorNode[]> =>
    (await provider.getChildren()).filter((n): n is SeparatorNode => n instanceof SeparatorNode);
  const first = async (provider: ModListProvider) => present((await separators(provider))[0], 'the separator row');
  const names = async (provider: ModListProvider) => (await separators(provider)).map((s) => s.separator.name);
  const iconId = (row: SeparatorNode) => (row.iconPath instanceof ThemeIcon ? row.iconPath.id : undefined);
  const valueWith = (separatorName: string) => valueOf([mod('A'), sep(separatorName)]);

  it('shows the new name at once, and the mark only after a delay', async () => {
    const provider = makeProvider([mod('A'), sep('Old')]);

    provider.markUnconfirmedRename('Old', 'New');

    expect(await names(provider)).toEqual(['New']);
    expect(iconId(await first(provider))).toBeUndefined();

    vi.advanceTimersByTime(1000);
    const marked = await first(provider);
    expect(iconId(marked)).toBe('sync~spin');
    expect(marked.tooltip).toBe('Written; waiting for the disk to confirm');
  });

  it('goes silently when the disk shows the new name', async () => {
    const instance = new FakeInstance(valueWith('Old'));
    const logged: string[] = [];
    const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
    provider.markUnconfirmedRename('Old', 'New');
    vi.advanceTimersByTime(1000);

    instance.publish(valueWith('New'));

    expect(await names(provider)).toEqual(['New']);
    expect(iconId(await first(provider))).toBeUndefined();
    expect(logged).toEqual([]);
  });

  it('keeps the new name and the mark through a pre-write value, then shows the disk\'s name and logs once a second still differs', async () => {
    const instance = new FakeInstance(valueWith('Old'));
    const logged: string[] = [];
    const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
    provider.markUnconfirmedRename('Old', 'New');
    vi.advanceTimersByTime(1000);

    instance.publish(valueWith('Old'));
    expect(await names(provider)).toEqual(['New']);
    expect(iconId(await first(provider))).toBe('sync~spin');

    instance.publish(valueWith('Old'));
    expect(await names(provider)).toEqual(['Old']);
    expect(iconId(await first(provider))).toBeUndefined();
    expect(logged).toEqual(['Separator "Old" was renamed "New", and the disk still shows "Old".']);
  });

  it('stays while the disk cannot be read', async () => {
    const instance = new FakeInstance(valueWith('Old'));
    const provider = makeProvider([], { instance });
    provider.markUnconfirmedRename('Old', 'New');
    vi.advanceTimersByTime(1000);

    instance.fail('locked');

    expect(iconId(await first(provider))).toBe('sync~spin');
  });

  it('a rename forgotten shows the disk\'s name at once, with no mark', async () => {
    const provider = makeProvider([mod('A'), sep('Old')]);
    provider.markUnconfirmedRename('Old', 'New');

    provider.forgetUnconfirmedRename('New');
    vi.advanceTimersByTime(1000);

    expect(await names(provider)).toEqual(['Old']);
    expect(iconId(await first(provider))).toBeUndefined();
  });
});

describe('a subject that vanishes from the disk while its write is unconfirmed', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a mod keeps its mark through one landed value without it, then logs one line and shows the disk', async () => {
    const instance = new FakeInstance(valueOf([mod('A'), mod('B')]));
    const logged: string[] = [];
    const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
    provider.markUnconfirmed('A', false);
    vi.advanceTimersByTime(1000);

    instance.publish(valueOf([mod('B')]));
    expect(logged).toEqual([]);
    instance.publish(valueOf([mod('B')]));

    expect(logged).toEqual(['"A" was written disabled, and it is gone from the disk.']);
    const names = (await provider.getChildren()).map((n) => (n instanceof ModNode ? n.mod.name : undefined));
    expect(names).not.toContain('A');
  });

  it('a separator rename that lands neither name logs one line after a second value', () => {
    const instance = new FakeInstance(valueOf([mod('A'), sep('Old')]));
    const logged: string[] = [];
    const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
    provider.markUnconfirmedRename('Old', 'New');
    vi.advanceTimersByTime(1000);

    instance.publish(valueOf([mod('A')]));
    expect(logged).toEqual([]);
    instance.publish(valueOf([mod('A')]));

    expect(logged).toEqual(['Separator "Old" was renamed "New", and the disk shows neither name.']);
  });
});

describe('an unconfirmed shape change (common.md, Unconfirmed writes, story 2)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const allRows = async (provider: ModListProvider): Promise<(ModNode | SeparatorNode)[]> => {
    const roots = (await provider.getChildren()).filter((n): n is ModNode | SeparatorNode => n instanceof ModNode || n instanceof SeparatorNode);
    const nested = await Promise.all(roots.map(async (root) => (root instanceof SeparatorNode ? provider.getChildren(root) : [])));
    return [...roots, ...nested.flat().filter((n): n is ModNode => n instanceof ModNode)];
  };
  const spinning = async (provider: ModListProvider): Promise<string[]> =>
    (await allRows(provider))
      .filter((row) => row.iconPath instanceof ThemeIcon && row.iconPath.id === 'sync~spin')
      .map((row) => (row instanceof ModNode ? row.mod.name : row.separator.name));
  const order = async (provider: ModListProvider): Promise<string[]> =>
    (await allRows(provider)).map((row) => (row instanceof ModNode ? row.mod.name : row.separator.name));

  describe('a move', () => {
    const moved = (): ModlistEntry[] => [
      mod('Early Fix', false), mod('Late Tweak'), sep('Late Section'), mod('Base Patch'), sep('Early Section'), mod('Old Mod'), mod('Oldest Mod'),
    ];

    it('leaves every row where it is, and marks the moved rows only after a delay', async () => {
      const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
      const before = await order(provider);

      provider.markMoved([{ kind: 'mod', name: 'Late Tweak' }, { kind: 'mod', name: 'Old Mod' }]);
      expect(await order(provider)).toEqual(before);
      expect(await spinning(provider)).toEqual([]);

      vi.advanceTimersByTime(1000);
      expect(await order(provider)).toEqual(before);
      expect(await spinning(provider)).toEqual(['Old Mod', 'Late Tweak']);
      const [marked] = (await allRows(provider)).filter((row) => row instanceof ModNode && row.mod.name === 'Late Tweak');
      expect(marked?.tooltip).toBe('Written; waiting for the disk to confirm');
    });

    it('goes silently, showing the disk\'s order, when the disk\'s order changed', async () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const logged: string[] = [];
      const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
      provider.markMoved([{ kind: 'mod', name: 'Late Tweak' }]);
      vi.advanceTimersByTime(1000);

      instance.publish(valueOf(moved()));

      expect(await spinning(provider)).toEqual([]);
      expect((await order(provider)).indexOf('Late Tweak')).toBeLessThan((await order(provider)).indexOf('Early Fix'));
      expect(logged).toEqual([]);
    });

    it('keeps the mark through a value that shows the old order, then logs one line and shows the disk', async () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const logged: string[] = [];
      const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
      provider.markMoved([{ kind: 'mod', name: 'Late Tweak' }, { kind: 'mod', name: 'Old Mod' }]);
      vi.advanceTimersByTime(1000);

      instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      expect(await spinning(provider)).toEqual(['Old Mod', 'Late Tweak']);
      expect(logged).toEqual([]);

      instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      expect(await spinning(provider)).toEqual([]);
      expect(logged).toEqual(['"Late Tweak", "Old Mod" was moved, and the disk does not show the move.']);
    });

    it('treats an unrelated reorder, an install or an uninstall as differing: the mark stays, and the next such value logs', async () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const logged: string[] = [];
      const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
      provider.markMoved([{ kind: 'mod', name: 'Late Tweak' }]);
      vi.advanceTimersByTime(1000);
      const swapped = orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt().map((e) => (e.name === 'Old Mod' ? mod('Oldest Mod') : e.name === 'Oldest Mod' ? mod('Old Mod') : e));

      instance.publish(valueOf(swapped));
      expect(await spinning(provider)).toEqual(['Late Tweak']);
      expect(logged).toEqual([]);

      instance.publish(valueOf([mod('Installed'), ...swapped]));
      expect(await spinning(provider)).toEqual([]);
      expect(logged).toEqual(['"Late Tweak" was moved, and the disk does not show the move.']);
    });

    it('a separator moved with its mods confirms when only that block relocated', async () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const logged: string[] = [];
      const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
      provider.markMoved([{ kind: 'separator', name: 'Late Section' }]);
      vi.advanceTimersByTime(1000);

      instance.publish(valueOf([mod('Base Patch'), sep('Early Section'), mod('Late Tweak'), mod('Early Fix', false), sep('Late Section'), mod('Old Mod'), mod('Oldest Mod')]));

      expect(await spinning(provider)).toEqual([]);
      expect(logged).toEqual([]);
    });

    it('stays while the disk cannot be read', async () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const provider = makeProvider([], { instance });
      provider.markMoved([{ kind: 'mod', name: 'Late Tweak' }]);
      vi.advanceTimersByTime(1000);

      instance.fail('locked');

      expect(await spinning(provider)).toEqual(['Late Tweak']);
    });

    it('forgetting the rows the write refused leaves the others marked', async () => {
      const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
      provider.markMoved([{ kind: 'mod', name: 'Late Tweak' }, { kind: 'mod', name: 'Old Mod' }]);

      provider.forgetUnconfirmedShape([{ kind: 'mod', name: 'Old Mod' }]);
      vi.advanceTimersByTime(1000);

      expect(await spinning(provider)).toEqual(['Late Tweak']);
    });

    it('marks a separator by its kind, not a mod of the same name', async () => {
      const provider = makeProvider([mod('Same'), sep('Same')]);

      provider.markMoved([{ kind: 'separator', name: 'Same' }]);
      vi.advanceTimersByTime(1000);

      expect((await allRows(provider)).filter((row) => row.iconPath instanceof ThemeIcon && row.iconPath.id === 'sync~spin').map((row) => row.kind))
        .toEqual(['separator']);
    });
  });

  describe('an uninstall or a delete', () => {
    it('keeps the row, and marks it only after a delay', async () => {
      const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());

      provider.markRemoved([{ kind: 'mod', name: 'Old Mod' }]);
      expect(await order(provider)).toContain('Old Mod');
      expect(await spinning(provider)).toEqual([]);

      vi.advanceTimersByTime(1000);
      expect(await order(provider)).toContain('Old Mod');
      expect(await spinning(provider)).toEqual(['Old Mod']);
    });

    it('the row leaves silently once the disk omits it, and stays through a value that lists it', async () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const logged: string[] = [];
      const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
      provider.markRemoved([{ kind: 'mod', name: 'Old Mod' }]);
      vi.advanceTimersByTime(1000);

      instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      expect(await spinning(provider)).toEqual(['Old Mod']);

      instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt().filter((e) => e.name !== 'Old Mod')));
      expect(await order(provider)).not.toContain('Old Mod');
      expect(logged).toEqual([]);
    });

    it('shows the disk\'s row unmarked and logs one line per row the disk still lists after a second value', async () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const logged: string[] = [];
      const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
      provider.markRemoved([{ kind: 'separator', name: 'Early Section' }]);
      vi.advanceTimersByTime(1000);

      instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));

      expect(await spinning(provider)).toEqual([]);
      expect(await order(provider)).toContain('Early Section');
      expect(logged).toEqual(['Separator "Early Section" was removed, and the disk still lists it.']);
    });

    it('names a mod as a mod in its line', () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const logged: string[] = [];
      const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
      provider.markRemoved([{ kind: 'mod', name: 'Old Mod' }]);

      instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      instance.publish(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));

      expect(logged).toEqual(['"Old Mod" was removed, and the disk still lists it.']);
    });

    it('stays while the disk cannot be read', async () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const provider = makeProvider([], { instance });
      provider.markRemoved([{ kind: 'mod', name: 'Old Mod' }]);
      vi.advanceTimersByTime(1000);

      instance.fail('locked');

      expect(await spinning(provider)).toEqual(['Old Mod']);
    });

    it('a write forgotten never shows the mark', async () => {
      const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
      provider.markRemoved([{ kind: 'mod', name: 'Old Mod' }]);

      provider.forgetUnconfirmedShape([{ kind: 'mod', name: 'Old Mod' }]);
      vi.advanceTimersByTime(1000);

      expect(await spinning(provider)).toEqual([]);
    });

    it('a write forgotten after its mark showed removes the mark at once', async () => {
      const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
      provider.markRemoved([{ kind: 'mod', name: 'Old Mod' }]);
      vi.advanceTimersByTime(1000);
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });

      provider.forgetUnconfirmedShape([{ kind: 'mod', name: 'Old Mod' }]);

      expect(fired).toBe(true);
      expect(await spinning(provider)).toEqual([]);
    });
  });

  describe('a created mod', () => {
    it('marks the separator the new mod will join, the first one from the winning end', async () => {
      const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());

      provider.markCreatedMod('New Mod');
      vi.advanceTimersByTime(1000);

      expect(await spinning(provider)).toEqual(['Late Section']);
      expect(await order(provider)).not.toContain('New Mod');
    });

    it('marks the winning-end separator when the list opens with one', async () => {
      const provider = makeProvider([sep('Top'), mod('A'), sep('Bottom')]);

      provider.markCreatedMod('New Mod');
      vi.advanceTimersByTime(1000);

      expect(await spinning(provider)).toEqual(['Top']);
    });

    it('marks no row when no separator holds it', async () => {
      const provider = makeProvider([mod('A'), mod('B')]);

      provider.markCreatedMod('New Mod');
      vi.advanceTimersByTime(1000);

      expect(await spinning(provider)).toEqual([]);
    });

    it('marks nothing in an empty list', async () => {
      const provider = makeProvider([]);

      provider.markCreatedMod('New Mod');
      vi.advanceTimersByTime(1000);

      expect(await spinning(provider)).toEqual([]);
    });

    describe('landing in two steps, the folder and then its line', () => {
      const folder = (name: string) => [{ kind: 'mod' as const, name, path: `/instance/mods/${name}` }];
      const before = () => valueOf([mod('A'), sep('S')]);

      it('goes silently once the disk lists the mod', async () => {
        const instance = new FakeInstance(before());
        const logged: string[] = [];
        const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
        provider.markCreatedMod('New Mod');
        vi.advanceTimersByTime(1000);

        instance.publish(valueOf([mod('New Mod', false), mod('A'), sep('S')]));

        expect(await spinning(provider)).toEqual([]);
        expect(logged).toEqual([]);
      });

      it('counts a value showing the folder alone as the write in progress: no grace used, nothing logged', async () => {
        const instance = new FakeInstance(before());
        const logged: string[] = [];
        const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
        provider.markCreatedMod('New Mod');
        vi.advanceTimersByTime(1000);

        instance.publish(before());
        instance.publish(valueOf([mod('A'), sep('S')], { modFolders: folder('New Mod') }));
        expect(await spinning(provider)).toEqual(['S']);
        instance.publish(valueOf([mod('New Mod', false), mod('A'), sep('S')], { modFolders: folder('New Mod') }));

        expect(await spinning(provider)).toEqual([]);
        expect(logged).toEqual([]);
      });

      it('logs one line when two values show neither step', () => {
        const instance = new FakeInstance(before());
        const logged: string[] = [];
        const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
        provider.markCreatedMod('New Mod');

        instance.publish(before());
        instance.publish(before());

        expect(logged).toEqual(['"New Mod" was created, and the disk does not list it.']);
      });

      it('logs once the grace runs out after the folder was seen and the line never came', () => {
        const instance = new FakeInstance(before());
        const logged: string[] = [];
        const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
        provider.markCreatedMod('New Mod');
        const folderOnly = () => valueOf([mod('A'), sep('S')], { modFolders: folder('New Mod') });

        instance.publish(folderOnly());
        instance.publish(folderOnly());
        expect(logged).toEqual([]);
        instance.publish(folderOnly());

        expect(logged).toEqual(['"New Mod" was created, and the disk does not list it.']);
      });
    });

    it('a write forgotten never shows the mark', async () => {
      const provider = makeProvider([mod('A')]);
      provider.markCreatedMod('New Mod');

      provider.forgetUnconfirmedShape([{ kind: 'mod', name: 'New Mod' }]);
      vi.advanceTimersByTime(1000);

      expect(await spinning(provider)).toEqual([]);
    });
  });

  describe('an added separator', () => {
    it('marks the separator that holds the anchor mod, and leaves the shape as it is', async () => {
      const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());
      const before = await order(provider);

      provider.markAddedSeparator('Fresh', { kind: 'mod', name: 'Base Patch' });
      vi.advanceTimersByTime(1000);

      expect(await order(provider)).toEqual(before);
      expect(await spinning(provider)).toEqual(['Early Section']);
    });

    it('marks an anchor separator itself', async () => {
      const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());

      provider.markAddedSeparator('Fresh', { kind: 'separator', name: 'Late Section' });
      vi.advanceTimersByTime(1000);

      expect(await spinning(provider)).toEqual(['Late Section']);
    });

    it('marks no row when no separator holds the anchor mod', async () => {
      const provider = makeProvider(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt());

      provider.markAddedSeparator('Fresh', { kind: 'mod', name: 'Old Mod' });
      vi.advanceTimersByTime(1000);

      expect(await spinning(provider)).toEqual([]);
    });

    it('goes silently once the disk lists the separator, and logs one line when a second value does not', () => {
      const instance = new FakeInstance(valueOf(orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt()));
      const logged: string[] = [];
      const provider = makeProvider([], { instance, log: (line) => logged.push(line) });
      provider.markAddedSeparator('Fresh', { kind: 'separator', name: 'Early Section' });
      provider.markAddedSeparator('Fresh Two', { kind: 'separator', name: 'Late Section' });

      instance.publish(valueOf([...orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt(), sep('Fresh')]));
      instance.publish(valueOf([...orderedWinningFirstEachSeparatorHeadingTheLinesAboveIt(), sep('Fresh')]));

      expect(logged).toEqual(['Separator "Fresh Two" was added, and the disk does not list it.']);
    });
  });
});
