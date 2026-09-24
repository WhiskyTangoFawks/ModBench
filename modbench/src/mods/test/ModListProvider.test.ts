import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// The check box's modlist.txt command, mocked at the module boundary, in the style already
// established by recordPanelContextCommands.test.ts.
const { setModsEnabledMock } = vi.hoisted(() => ({
  setModsEnabledMock: vi.fn<typeof setModsEnabled>(),
}));
vi.mock('../../modlist/modlist', () => ({
  setModsEnabled: (...args: Parameters<typeof setModsEnabledMock>) => setModsEnabledMock(...args),
}));

import { ModListProvider, SeparatorNode, ModNode, OverwriteNode, type ModlistNode } from '../ModListProvider';
import { ErrorNode } from '../errorNode';
import { onModCheckboxChanged } from '../modCheckboxHandler';
import { recordingReporter } from '../../test/surfacingDoubles';
import { withUnreadCorpusInstance } from '../../test/mo2/unreadCorpusInstance';
import { expectInstanceOf, expectInstancesOf } from '../../test/expectInstanceOf';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

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

// Only `.mods`, `.activeProfile`, `.modStatuses` and `.overwriteFileCount` matter here — a
// provider reaching for `.files`/`.filesByMod` to derive a badge itself would find them `undefined`.
function valueOf(
  mods: ModlistEntry[],
  extra: Partial<Pick<InstanceValue, 'activeProfile' | 'modStatuses' | 'overwriteFileCount' | 'paths'>> = {},
): InstanceValue {
  return instanceValueFixture({
    mods,
    activeProfile: extra.activeProfile ?? ACTIVE_PROFILE,
    modStatuses: extra.modStatuses ?? new Map<string, ModStatusResult>(),
    overwriteFileCount: extra.overwriteFileCount ?? 0,
    ...(extra.paths ? { paths: extra.paths } : {}),
  });
}

// The double the row provider's own contract needs: `.value` plus `.subscribe`, structurally
// compatible with `Instance` without ever constructing one (ADR-0015's watchers are Instance's
// concern, not this provider's).
class FakeInstance {
  value: InstanceValue;
  // Defaults to 1 ("already loaded") so every existing fixture-based test needs no opinion on
  // it; a test of the sequence === 0 ("not read yet") guard passes 0 explicitly.
  sequence: number;
  readFailure: string | undefined;
  private subscribers: ((value: InstanceValue, sequence: number) => void)[] = [];
  private failureListeners: (() => void)[] = [];
  constructor(initial: InstanceValue, sequence = 1) {
    this.value = initial;
    this.sequence = sequence;
  }
  subscribe(subscriber: (value: InstanceValue, sequence: number) => void) {
    this.subscribers.push(subscriber);
    return { dispose: () => { this.subscribers = this.subscribers.filter((s) => s !== subscriber); } };
  }
  // Simulates a landed recompute: publishes to every live subscriber, the way Instance's own
  // watcher-driven recompute does.
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
  // Simulates a recompute that threw: the value and sequence stay put, and the reason is held.
  fail(reason: string): void {
    this.readFailure = reason;
    for (const listener of [...this.failureListeners]) listener();
  }
}

// A hang must fail on an explicit assertion, not the test runner's own timeout.
const within = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`getChildren() did not settle within ${ms} ms`)), ms)),
]);

const makeProvider = (
  mods: ModlistEntry[],
  extra: Partial<{ instance: FakeInstance; instanceRoot: string }> = {},
) => new ModListProvider({
  instance: extra.instance ?? new FakeInstance(valueOf(mods)),
  instanceRoot: extra.instanceRoot ?? INSTANCE_ROOT,
});

// modlist.txt runs winning-first and a separator heads the lines above it: Late Section holds
// Late Tweak and Early Fix, Early Section holds Base Patch, and the last two are ungrouped.
const ordered = (): ModlistEntry[] => [
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
    const provider = makeProvider(ordered());

    expect(rowsOf(await provider.getChildren())).toEqual([
      'mod Oldest Mod', 'mod Old Mod', 'separator Early Section', 'separator Late Section', 'overwrite Overwrite',
    ]);
  });

  it('winning at the top: Overwrite first, then the separators, then the ungrouped mods', async () => {
    const provider = makeProvider(ordered());
    provider.setViewDirection('winningAtTop');

    expect(rowsOf(await provider.getChildren())).toEqual([
      'overwrite Overwrite', 'separator Late Section', 'separator Early Section', 'mod Old Mod', 'mod Oldest Mod',
    ]);
  });

  it('a separator\'s mods follow the direction', async () => {
    const provider = makeProvider(ordered());
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
    const instance = new FakeInstance(valueOf(ordered()));
    const provider = makeProvider([], { instance });
    const idsOf = async () => (await provider.getChildren()).map((n) => n.id);
    const before = await idsOf();

    instance.publish(valueOf(ordered(), { overwriteFileCount: 4 }));

    expect(await idsOf()).toEqual(before);
    expect(new Set(before).size).toBe(before.length);
  });
});

// MO2 reads a line it has already read as nothing, and VS Code renders no two rows with one id.
describe('a line modlist.txt repeats', () => {
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
    const provider = makeProvider(ordered());
    provider.setFilter('late', true);

    expect(provider.description()).toBe('4 / 5');
  });

  it('says there are no mods or separators, and how to add one', () => {
    expect(makeProvider([]).emptyListMessage()).toBe(NO_MODS);
  });

  it('says nothing of an empty list while a separator alone is listed', () => {
    expect(makeProvider([sep('Only')]).emptyListMessage()).toBeUndefined();
  });

  // Before the first read the value is the empty sentinel, which is "not read yet".
  it('says nothing before the first read lands', () => {
    const provider = makeProvider([], { instance: new FakeInstance(valueOf([]), 0) });

    expect(provider.description()).toBeUndefined();
    expect(provider.emptyListMessage()).toBeUndefined();
  });
});

// VS Code's reveal walks up through getParent, and a filter's expansion is a reveal.
describe('a row\'s parent', () => {
  it('is the separator that holds a mod, and nothing for a root', async () => {
    const provider = makeProvider(ordered());
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
  // Rival: the provider ignores the injected value and falls back to a read of its own — with
  // that rival, these rows would be empty/wrong rather than exactly what the fixture says.
  it('rows exactly match the fixture value — not a re-derivation', async () => {
    const provider = makeProvider([mod('Zed'), mod('Aardvark')]);
    const roots = await provider.getChildren();
    const labels = roots.filter((n): n is ModNode => n instanceof ModNode).map((n) => n.label);
    // file order, reversed for the default losing-at-top view — not alphabetical.
    expect(labels).toEqual(['Aardvark', 'Zed']);
  });

  // Mod sync is what adds a line, so a folder with no line has no row until the line exists.
  // Rival: a tree that renders the value's folders rather than its lines.
  it('renders no row for a folder in mods/ with no modlist line', async () => {
    const value = { ...valueOf([mod('Listed')]), modFolders: ['Listed', 'Dropped In'] } as InstanceValue;
    const provider = makeProvider([], { instance: new FakeInstance(value) });

    const labels = (await provider.getChildren()).map((n) => n.label);

    expect(labels).toContain('Listed');
    expect(labels).not.toContain('Dropped In');
  });

  it('returns a separator’s mods as ModNodes with checkbox, version, tooltip', async () => {
    // The separator's members are the entries preceding it.
    const provider = makeProvider([
      mod('UFO4P', true, { version: 'v2.1.5', nexusId: '4598', archiveFilename: 'UFO4P.7z' }),
      mod('Disabled Mod', false),
      sep('Section'),
    ]);
    const roots = await provider.getChildren();
    const separator = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode), "the sole SeparatorNode");
    const children = await provider.getChildren(separator);

    expect(children).toHaveLength(2);
    // Default losing-at-top view reverses each sibling list, so the later file
    // entry (Disabled Mod) renders first.
    const modNodes = expectInstancesOf(children, ModNode);
    const disabled = present(modNodes[0], 'the disabled mod row');
    const enabled = present(modNodes[1], 'the enabled mod row');
    expect(enabled.label).toBe('UFO4P');
    expect(enabled.description).toBe('v2.1.5');
    expect(enabled.checkboxState).toBe(1); // Checked
    expect(enabled.tooltip).toBe('UFO4P · v2.1.5 · 4598 · UFO4P.7z');
    expect(disabled.checkboxState).toBe(0); // Unchecked
    expect(disabled.tooltip).toBe('Disabled Mod'); // no extra fields
  });

  // package.json's mod-menu `when` clauses read these flags to offer enable or disable by row
  // state (mods.md, Menus and keys, story 3), and view on Nexus by hasNexus.
  it('a mod row states its enabled state and whether it has a Nexus id in its contextValue', async () => {
    const provider = makeProvider([
      mod('UFO4P', true, { nexusId: '4598' }),
      mod('Disabled Mod', false),
    ]);
    const rows = (await provider.getChildren()).filter((n): n is ModNode => n instanceof ModNode);
    const enabled = present(rows.find((n) => n.mod.name === 'UFO4P'), 'the enabled row');
    const disabled = present(rows.find((n) => n.mod.name === 'Disabled Mod'), 'the disabled row');

    expect(enabled.contextValue).toBe('mod hasNexus enabled');
    expect(disabled.contextValue).toBe('mod disabled');
  });

  // ADR-0015 invariant 2: the watch brings the landed write back, as it would MO2's. The check
  // box reaches the same command a context-menu click or key does — one mod, through the entry.
  it('setModEnabled calls the setModsEnabled command with the instance root, active profile and one-mod selection, and fires no refresh', async () => {
    const provider = makeProvider([mod('A')]);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await provider.setModEnabled('A', false);

    expect(setModsEnabledMock).toHaveBeenCalledWith(INSTANCE_ROOT, ACTIVE_PROFILE, ['A'], false);
    expect(fired).toBe(false);
  });

  // A modlist command answers applied or a refusal and never throws for one; the provider turns
  // a refusal into a rejected promise, so the checkbox handler has one failure path, not two.
  it('setModEnabled throws when the command globally refuses, and fires no refresh', async () => {
    setModsEnabledMock.mockResolvedValue({ applied: false, refusal: 'nope' });
    const provider = makeProvider([mod('A')]);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await expect(provider.setModEnabled('A', false)).rejects.toThrow('nope');
    expect(fired).toBe(false);
  });

  // A gone mod comes back as a per-item refusal in an otherwise-applied outcome, not a global one.
  it('setModEnabled throws the per-item refusal when the one mod it asked for comes back refused', async () => {
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

  // Rival: subscribe but drop the callback, or never subscribe — rows would stay at the value
  // handed to the constructor. Must not be vacuous at first render only: this asserts a SECOND,
  // later value is also picked up.
  it('re-renders on a new value published after construction', async () => {
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

  // The empty value before the first read is "not read yet", never "no mods": a render asked for
  // before the read, and awaited after it, shows the rows that read lands.
  it('renders no rows before the first read, and the read\'s rows once it lands', async () => {
    await withUnreadCorpusInstance(async (instance, root) => {
      const provider = new ModListProvider({ instance, instanceRoot: root });

      const pending = provider.getChildren();
      await instance.refresh();
      const rendered = (await pending).map((n) => n.label);

      expect(rendered.length).toBeGreaterThan(1);
      expect(rendered).toEqual((await provider.getChildren()).map((n) => n.label));
      provider.dispose();
    });
  });

  // The timeout is the finding: a gate that settles only on a landed value leaves a first read
  // that threw spinning forever (ADR-0019).
  it('settles a failed first read on the one error row naming the reason, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const provider = makeProvider([], { instance });

    const pending = provider.getChildren();
    instance.fail('EACCES: permission denied, open modlist.txt');
    const rows = await within(pending, 500);

    expect(rows).toHaveLength(1);
    const error = expectInstanceOf(rows[0], ErrorNode);
    expect(error.label).toBe('Failed to load: EACCES: permission denied, open modlist.txt');
    expect(error.tooltip).toBe('EACCES: permission denied, open modlist.txt');
    expect(error.iconPath).toEqual(new ThemeIcon('error'));

    instance.publish(valueOf([mod('A')]));
    const after = await within(provider.getChildren(), 500);

    expect(after.some((n) => n instanceof ModNode)).toBe(true);
    expect(after.some((n) => n instanceof ErrorNode)).toBe(false);
  });

  it('renders a genuinely empty modlist immediately, as the Overwrite row alone, when the first landed value already carries none', async () => {
    const provider = makeProvider([], { instance: new FakeInstance(valueOf([]), 1) });
    expect(rowsOf(await provider.getChildren())).toEqual(['overwrite Overwrite']);
  });

  describe('setFilter — grouping on (default)', () => {
    // Group A's real members are the entries preceding it (Zeta, Alpha
    // Child); Group B's are the entries preceding it back to Group A (Gamma).
    // Alpha/Beta trail the last separator and are ungrouped.
    const entries = (): ModlistEntry[] => [
      mod('Zeta'),
      mod('Alpha Child'),
      sep('Group A'),
      mod('Gamma'),
      sep('Group B'),
      mod('Alpha'),
      mod('Beta'),
    ];

    it('filter with groupingOn hides separators with no matches', async () => {
      const provider = makeProvider(entries());
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();

      const labels = roots.map((n) => n.label);
      expect(labels).toContain('Alpha');           // ungrouped match
      expect(labels).not.toContain('Beta');         // ungrouped non-match
      expect(labels).toContain('Group A');          // has matching child (Alpha Child)
      expect(labels).not.toContain('Group B');      // no matches (only Gamma)
    });

    it('filter with groupingOn shows only matching children under separator', async () => {
      const provider = makeProvider(entries());
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();
      const sepNode = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode), "the sole SeparatorNode");
      const children = await provider.getChildren(sepNode);

      // Group A's members are [Zeta, Alpha Child]; only Alpha Child matches.
      expect(children.map((n) => n.label)).toEqual(['Alpha Child']);
    });

    it('separator name match causes all its children to be shown', async () => {
      const provider = makeProvider(entries());
      provider.setFilter('group a', true);
      const roots = await provider.getChildren();
      const sepNode = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode), "the sole SeparatorNode");
      expect(sepNode.label).toBe('Group A');
      const children = await provider.getChildren(sepNode);
      // Separator name matches, so BOTH members show — including Zeta, which
      // wouldn't match 'alpha' on its own.
      expect(children.map((n) => n.label)).toEqual(['Alpha Child', 'Zeta']); // reversed: losing-at-top default
    });

    it('fires onDidChangeTreeData when filter is set', () => {
      const provider = makeProvider(entries());
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });
      provider.setFilter('x', true);
      expect(fired).toBe(true);
    });

    // A filter keystroke must re-render already-built rows, never re-pull the instance value.
    it('setFilter does not rebuild rows (render-only, not invalidate)', async () => {
      const instance = new FakeInstance(valueOf(entries()));
      const provider = makeProvider([], { instance });
      await provider.getChildren();

      instance.value = valueOf([mod('Alpha')]); // no publish(), no invalidate()
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();

      // The stale cache (built off the original 7-entry fixture), not the mutated value.
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

    // A separator wraps the entries that PRECEDE it, so Group A holds Alpha, Group B holds
    // Beta and Gamma, and Delta trails the last separator ungrouped.
    const dndEntries: ModlistEntry[] = [
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
      const provider = makeProvider(dndEntries);

      await dragAndDrop(provider, ['Alpha', 'Delta'], 'Gamma');

      const rows = await shownRows(provider);
      const argument = [rowLabelled(rows, 'Alpha'), rowLabelled(rows, 'Delta')];
      expect(movesFired()).toEqual([[
        'modbench.mod.move', argument[0], argument, { place: { kind: 'mod', name: 'Gamma' }, end: 'losing' },
      ]]);
    });

    it('a drop follows the view\'s sort direction', async () => {
      const provider = makeProvider(dndEntries);
      provider.setViewDirection('winningAtTop');

      await dragAndDrop(provider, ['Group B'], undefined);

      expect(movesFired().map((call) => call[3])).toEqual([{ place: { kind: 'modOrder' }, end: 'losing' }]);
    });

    it('a drag that mixes kinds takes the kind of the row VS Code last added to the selection', async () => {
      const provider = makeProvider(dndEntries);

      await dragAndDrop(provider, ['Group B', 'Delta'], 'Group A');
      await dragAndDrop(provider, ['Delta', 'Group B'], 'Group A');

      expect(movesFired().map(argumentLabels)).toEqual([['Delta'], ['Group B']]);
    });

    it('a drop where what is dragged cannot go fires nothing', async () => {
      const provider = makeProvider(dndEntries);

      await dragAndDrop(provider, ['Delta'], 'Overwrite');
      await dragAndDrop(provider, ['Alpha', 'Delta'], 'Alpha');
      await dragAndDrop(provider, ['Group B'], 'Delta');

      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('Overwrite is carried by no drag', async () => {
      const provider = makeProvider(dndEntries);
      const rows = await shownRows(provider);
      const dataTransfer = new DataTransfer();

      provider.handleDrag([rowLabelled(rows, 'Delta'), rowLabelled(rows, 'Overwrite')], dataTransfer, token);
      await provider.handleDrop(rowLabelled(rows, 'Gamma'), dataTransfer, token);

      expect(movesFired().map(argumentLabels)).toEqual([['Delta']]);
    });

    it('nothing from outside the view drops here', async () => {
      const provider = makeProvider(dndEntries);
      const rows = await shownRows(provider);
      const dataTransfer = new DataTransfer();
      dataTransfer.set(MIME, new DataTransferItem({ kind: 'mod', name: 'Delta' }));
      dataTransfer.set('text/uri-list', new DataTransferItem('file:///downloads/SomeMod.7z'));

      await provider.handleDrop(rowLabelled(rows, 'Gamma'), dataTransfer, token);

      expect(provider.dropMimeTypes).toEqual([MIME]);
      expect(executeCommand).not.toHaveBeenCalled();
    });

    // A drop moves no row on screen by itself: the watch brings the write back (ADR-0015
    // invariant 2).
    it('a drop asks for no refresh', async () => {
      const provider = makeProvider(dndEntries);
      await shownRows(provider);
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });

      await dragAndDrop(provider, ['Delta'], 'Group A');

      expect(movesFired()).toHaveLength(1);
      expect(fired).toBe(false);
    });
  });

  describe('setFilter — reset behaviour', () => {
    it('clearing filter resets groupingOn to true and shows all nodes', async () => {
      const provider = makeProvider([sep('Sep'), mod('Mod')]);
      provider.setFilter('x', false);
      provider.setFilter('', false); // grouping arg ignored when text cleared
      const roots = await provider.getChildren();
      expect(roots.some((n) => n instanceof SeparatorNode)).toBe(true);
    });
  });

  describe('view direction', () => {
    // modlist.txt file order is winning-first (top of file wins). The default
    // view puts the LOSING end on top (base/vanilla-adjacent mods first),
    // matching MO2 — so a sibling list renders reversed from file order.
    it('default view renders the losing end (last file entry) at the top', async () => {
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

    it('toggled to winning-at-top: mods within a separator are in file order', async () => {
      // The separator's members are the entries preceding it.
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
      // Group A's real member is Alpha (preceding it); Alpha Child/Alpha
      // Other trail the last separator and are ungrouped.
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
      // Group A's real members are Alpha Child/Alpha Other (preceding it);
      // Alpha trails the last separator and is ungrouped.
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

  // Badges come straight off `instance.value.modStatuses` — a fixture map, no disk and no
  // temporary instance.
  describe('status badges (from the Instance value)', () => {
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

    // The filter only narrows which already-built rows render — a row's badge is a fixed field
    // of the value, never recomputed on filter.
    it('keeps a conflicted mod\'s badge identical after filtering it in, and after clearing the filter', async () => {
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

    // View order (winningAtTop, presentation-only) and override order (who wins a file
    // conflict) are provably independent — flipping the view never changes the winner.
    it('flipping the view direction never changes a conflict\'s winner', async () => {
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

    // Rival: the view recomputes the badge itself. This fixture carries no `.files`/
    // `.filesByMod` — reaching for either finds `undefined` — and the count (7) can't arise
    // from any real computation over data this fixture doesn't have.
    it('renders the status badge exactly as given by the Instance value — the view computes nothing', async () => {
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

  // A pinned leaf outside separator grouping, over the value's own count: no disk and no
  // temporary instance.
  describe('Overwrite row', () => {
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

    // A resourceUri would hand the label to every file decoration provider, git's included.
    it('is not a mod: no check box, no click, no resourceUri, and its own menu', async () => {
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
