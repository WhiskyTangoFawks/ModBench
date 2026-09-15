import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mod, ModlistEntry, Separator } from './model';
import { parseModlist, moveModInText, moveSeparatorBlockInText, writeModlist } from './mo2/modlistText';
import type { InstanceValue } from './instance';
import type { ModStatusResult } from './statusChecker';
import { present } from '../present';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon,
  uriFile, DataTransferItem, DataTransfer, FakeCancellationToken, fakeUri,
} from '../test/vscodeMock';
import type {
  setModEnabled, reorderMod, moveModToSeparator, reorderSeparatorBlock,
} from './commands/modlist';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
}));

// Every modlist.txt gesture the provider fires goes through these free commands now (ADR-0015
// point 6) rather than an injected source — mocked at the module boundary, in the style already
// established by recordPanelContextCommands.test.ts.
const {
  setModEnabledMock, reorderModMock, moveModToSeparatorMock, reorderSeparatorBlockMock,
} = vi.hoisted(() => ({
  setModEnabledMock: vi.fn<typeof setModEnabled>(),
  reorderModMock: vi.fn<typeof reorderMod>(),
  moveModToSeparatorMock: vi.fn<typeof moveModToSeparator>(),
  reorderSeparatorBlockMock: vi.fn<typeof reorderSeparatorBlock>(),
}));
vi.mock('./commands/modlist', () => ({
  setModEnabled: (...args: Parameters<typeof setModEnabledMock>) => setModEnabledMock(...args),
  reorderMod: (...args: Parameters<typeof reorderModMock>) => reorderModMock(...args),
  moveModToSeparator: (...args: Parameters<typeof moveModToSeparatorMock>) => moveModToSeparatorMock(...args),
  reorderSeparatorBlock: (...args: Parameters<typeof reorderSeparatorBlockMock>) => reorderSeparatorBlockMock(...args),
}));

import { ModListProvider, CountNode, SeparatorNode, ModNode, OverwriteNode, type ModlistNode } from './ModListProvider';
import { ErrorNode } from '../errorNode';
import { recordingReporter } from '../test/surfacingDoubles';
import { expectInstanceOf, expectInstancesOf } from '../test/expectInstanceOf';
import { instanceValueFixture } from './test/instanceValueFixture';
import type { Reporter } from '../reporter';

const INSTANCE_ROOT = '/instance';
const ACTIVE_PROFILE = 'Default';

beforeEach(() => {
  for (const m of [setModEnabledMock, reorderModMock, moveModToSeparatorMock, reorderSeparatorBlockMock]) {
    m.mockReset();
    m.mockResolvedValue({ applied: true, wrote: true });
  }
});

const mod = (name: string, enabled = true, extra: Partial<Mod> = {}): Mod => ({
  kind: 'mod', name, enabled, ...extra,
});
const sep = (name: string, enabled = false): Separator => ({ kind: 'separator', name, enabled });

// Only `.mods`, `.activeProfile`, `.modStatuses` and `.overwriteFileCount` matter here — a
// provider reaching for `.files`/`.filesByMod` to derive a badge itself would find them `undefined`.
function valueOf(
  mods: ModlistEntry[],
  extra: Partial<Pick<InstanceValue, 'activeProfile' | 'modStatuses' | 'overwriteFileCount'>> = {},
): InstanceValue {
  return instanceValueFixture({
    mods,
    activeProfile: extra.activeProfile ?? ACTIVE_PROFILE,
    modStatuses: extra.modStatuses ?? new Map<string, ModStatusResult>(),
    overwriteFileCount: extra.overwriteFileCount ?? 0,
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
  private failureListeners: ((reason: string) => void)[] = [];
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
  onReadFailure(listener: (reason: string) => void) {
    this.failureListeners.push(listener);
    return { dispose: () => { this.failureListeners = this.failureListeners.filter((l) => l !== listener); } };
  }
  // Simulates a recompute that threw: the value and sequence stay put, the reason goes out.
  fail(reason: string): void {
    this.readFailure = reason;
    for (const listener of [...this.failureListeners]) listener(reason);
  }
}

// A hang must fail on an explicit assertion, not the test runner's own timeout.
const within = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`getChildren() did not settle within ${ms} ms`)), ms)),
]);

const makeProvider = (
  mods: ModlistEntry[],
  extra: Partial<{
    instance: FakeInstance;
    log: (m: string) => void; reporter: Reporter;
    instanceRoot: string;
  }> = {},
) => new ModListProvider({
  instance: extra.instance ?? new FakeInstance(valueOf(mods)),
  log: extra.log,
  reporter: extra.reporter,
  instanceRoot: extra.instanceRoot ?? INSTANCE_ROOT,
});

describe('ModListProvider', () => {
  it('builds root children: count node, then separators, then ungrouped mods (losing-at-top default)', async () => {
    // A separator's members are the entries PRECEDING it — Alpha/Beta
    // here. Gamma/Delta trail the last separator and are ungrouped. The default
    // losing-at-top view pushes ungrouped mods below the separators and reverses
    // each sibling list.
    const provider = makeProvider([
      mod('Alpha'),
      mod('Beta', false),
      sep('Section 1'),
      mod('Gamma'),
      mod('Delta', false),
    ]);
    const roots = await provider.getChildren();

    expect(roots[0]).toBeInstanceOf(CountNode);
    expect(present(roots[0], 'the first root').label).toBe('2 active / 4 installed');
    expect(roots[1]).toBeInstanceOf(SeparatorNode);
    expect(present(roots[1], 'the second root').label).toBe('Section 1');
    expect(roots[2]).toBeInstanceOf(ModNode);
    expect(present(roots[2], 'the third root').label).toBe('Delta');
    expect(roots[3]).toBeInstanceOf(ModNode);
    expect(present(roots[3], 'the fourth root').label).toBe('Gamma');
  });

  // Rival: the provider ignores the injected value and falls back to a read of its own — with
  // that rival, these rows would be empty/wrong rather than exactly what the fixture says.
  it('rows exactly match the fixture value — not a re-derivation', async () => {
    const provider = makeProvider([mod('Zed'), mod('Aardvark')]);
    const roots = await provider.getChildren();
    const labels = roots.filter((n): n is ModNode => n instanceof ModNode).map((n) => n.label);
    // file order, reversed for the default losing-at-top view — not alphabetical.
    expect(labels).toEqual(['Aardvark', 'Zed']);
  });

  // Adoption is the gesture that adds a mod, so a folder the value carries as unlisted has no
  // row until its modlist line exists. Rival: a tree that renders both fields.
  it('renders no row for a folder the value carries as unlisted', async () => {
    const value = { ...valueOf([mod('Listed')]), unlistedFolders: ['Dropped In'] } as InstanceValue;
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

  it('setModEnabled calls the setModEnabled command with the instance root, active profile and inputs, and fires a refresh', async () => {
    const provider = makeProvider([mod('A')]);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await provider.setModEnabled('A', false);

    expect(setModEnabledMock).toHaveBeenCalledWith(INSTANCE_ROOT, ACTIVE_PROFILE, 'A', false);
    expect(fired).toBe(true);
  });

  // The command returns a refusal rather than throwing (ADR-0015 invariant 2); the provider turns
  // that into a rejected promise so existing callers (the checkbox handler) keep their contract.
  it('setModEnabled throws when the command refuses, and fires no refresh', async () => {
    setModEnabledMock.mockResolvedValue({ applied: false, refusal: 'nope' });
    const provider = makeProvider([mod('A')]);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await expect(provider.setModEnabled('A', false)).rejects.toThrow('nope');
    expect(fired).toBe(false);
  });

  // Asymmetry test: unlike setFilter (render-only), a mutation must invalidate — the next
  // getChildren() re-pulls the Instance's current value, since a mutation may have changed it.
  it('setModEnabled invalidates: a subsequent getChildren() re-pulls the instance value', async () => {
    const instance = new FakeInstance(valueOf([mod('A')]));
    const provider = makeProvider([], { instance });
    await provider.getChildren();

    instance.value = valueOf([mod('A'), mod('B')]); // no publish() — set directly, as a stale-cache probe
    await provider.setModEnabled('A', false);
    const roots = await provider.getChildren();

    expect(roots.filter((n): n is ModNode => n instanceof ModNode).map((n) => n.label)).toContain('B');
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

  // sequence === 0 means "the Instance has not read yet", never "genuinely empty" — a real empty
  // modlist lands at sequence 1. getChildren() must not render before the Instance's first value.
  it('does not resolve getChildren() until the Instance lands its first value (sequence 0)', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const provider = makeProvider([], { instance });

    let settled = false;
    const pending = provider.getChildren().then((rows) => { settled = true; return rows; });
    // A macrotask boundary, not a microtask one — a single `await Promise.resolve()` would pass
    // whether or not getChildren() actually waits on the Instance.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    instance.publish(valueOf([mod('A')]));
    const rows = await pending;

    expect(settled).toBe(true);
    expect(rows.some((n) => n instanceof ModNode)).toBe(true);
  });

  // The timeout is the finding: a gate that settles only on a landed value leaves a first read
  // that threw spinning forever — no row, no error node, no toast (ADR-0019).
  it('settles a failed first read on one error node naming the reason, reports once, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const reporter = recordingReporter();
    const provider = makeProvider([], { instance, reporter });

    const pending = provider.getChildren();
    instance.fail('EACCES: permission denied, open modlist.txt');
    const rows = await within(pending, 500);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(ErrorNode);
    expect(present(rows[0], 'the sole row').label).toBe('⚠ Failed to load: EACCES: permission denied, open modlist.txt');
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to read the MO2 instance.', detail: 'EACCES: permission denied, open modlist.txt' },
    ]);

    instance.publish(valueOf([mod('A')]));
    const after = await within(provider.getChildren(), 500);

    expect(after.some((n) => n instanceof ModNode)).toBe(true);
    expect(after.some((n) => n instanceof ErrorNode)).toBe(false);
    expect(reporter.reports).toHaveLength(1);
  });

  it('renders a genuinely empty modlist immediately when the first landed value already carries none', async () => {
    const provider = makeProvider([], { instance: new FakeInstance(valueOf([]), 1) });
    const roots = await provider.getChildren();
    expect(roots).toHaveLength(1); // just the count node
    expect(roots[0]).toBeInstanceOf(CountNode);
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
    // Only setFilter is render-only; every other call site still invalidates (see the asymmetry
    // test above and the drag-and-drop section).
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

    it('flat list: only matching mods, no separators, no count', async () => {
      const provider = makeProvider(entries);
      provider.setFilter('alpha', false);
      const roots = await provider.getChildren();

      expect(roots.every((n) => n instanceof ModNode)).toBe(true);
      expect(roots.map((n) => n.label)).toEqual(['Alpha Child', 'Alpha']); // reversed: losing-at-top default
    });
  });

  describe('drag-and-drop', () => {
    const item = (value: unknown): DataTransferItem => new DataTransferItem(value);
    const token = new FakeCancellationToken();

    // A separator wraps the entries that PRECEDE it, so Group A holds Alpha, Group B holds
    // Beta and Gamma, and Delta trails the last separator ungrouped.
    const dndEntries: ModlistEntry[] = [
      mod('Alpha'),           // index 0 — Group A's member
      sep('Group A'),         // index 1
      mod('Beta'),            // index 2 — Group B's member
      mod('Gamma'),           // index 3 — Group B's member
      sep('Group B'),         // index 4
      mod('Delta'),           // index 5 — ungrouped (after the last separator)
    ];

    function makeDndProvider() {
      const provider = makeProvider(dndEntries);
      return { provider };
    }

    // Real modlist.txt transforms applied to an in-memory `text`, so tests assert the drop's
    // final entry order against `order()`, not the row provider's own un-refreshed rendering.
    function makeApplyingProvider() {
      let text = writeModlist(dndEntries);
      reorderModMock.mockImplementation((_root: string, _profile: string, name: string, idx: number) => {
        text = moveModInText(text, name, idx);
        return Promise.resolve({ applied: true, wrote: true });
      });
      reorderSeparatorBlockMock.mockImplementation((_root: string, _profile: string, sepName: string, idx: number) => {
        text = moveSeparatorBlockInText(text, sepName, idx);
        return Promise.resolve({ applied: true, wrote: true });
      });
      const provider = makeProvider(dndEntries);
      return { provider, order: () => parseModlist(text).map((e) => e.name) };
    }

    async function childrenOf(provider: ModListProvider, sepName: string): Promise<ModNode[]> {
      const roots = await provider.getChildren();
      const sepNode = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode && n.label === sepName), "the sole SeparatorNode");
      return expectInstancesOf(await provider.getChildren(sepNode), ModNode);
    }

    const modItem = (name: string): DataTransferItem => item({ kind: 'mod', name });
    const sepItem = (name: string): DataTransferItem => item({ kind: 'separator', name });
    async function drop(provider: ModListProvider, target: ModlistNode | undefined, payload: DataTransferItem): Promise<void> {
      const dt = new DataTransfer();
      dt.set('application/vnd.medit.modlist-node', payload);
      await provider.handleDrop(target, dt, token);
    }

    it('handleDrag serialises the dragged mod into dataTransfer', async () => {
      const { provider } = makeDndProvider();
      // Alpha is Group A's member (the entry preceding it), not a root.
      const alphaNode = present((await childrenOf(provider, 'Group A')).find((n) => n.label === 'Alpha'), "the 'Alpha' node");
      const dt = new DataTransfer();
      provider.handleDrag([alphaNode], dt, token);
      const got = dt.get('application/vnd.medit.modlist-node');
      expect(got?.value).toEqual({ kind: 'mod', name: 'Alpha' });
    });

    it('drop mod onto separator → moveModToSeparator', async () => {
      const { provider } = makeDndProvider();
      const roots = await provider.getChildren();
      const sepNode = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode && n.label === 'Group A'), "the 'Group A' node");
      const dt = new DataTransfer();
      dt.set('application/vnd.medit.modlist-node', item({ kind: 'mod', name: 'Alpha' }));
      await provider.handleDrop(sepNode, dt, token);
      expect(moveModToSeparatorMock).toHaveBeenCalledWith(INSTANCE_ROOT, ACTIVE_PROFILE, 'Alpha', 'Group A');
    });

    // Down-drag off-by-one: passing the pre-removal target index would land Alpha one slot
    // too low.
    it('winning-at-top down-drag: drop mod onto a lower mod lands it before that mod', async () => {
      const { provider, order } = makeApplyingProvider();
      provider.toggleViewDirection(); // -> winning-at-top (view == file order)
      const gammaNode = present((await childrenOf(provider, 'Group B')).find((n) => n.label === 'Gamma'), "the 'Gamma' node");
      await drop(provider, gammaNode, modItem('Alpha'));
      expect(order()).toEqual(['Group A', 'Beta', 'Alpha', 'Gamma', 'Group B', 'Delta']);
    });

    // Regression: up-drags were never affected (nothing moved sits above the
    // target, so no shift) — must stay correct.
    // Beta is Group B's member (it precedes Group B's line), not Group A's.
    it('winning-at-top up-drag: drop mod onto a higher mod lands it before that mod', async () => {
      const { provider, order } = makeApplyingProvider();
      provider.toggleViewDirection(); // -> winning-at-top (view == file order)
      const betaNode = present((await childrenOf(provider, 'Group B')).find((n) => n.label === 'Beta'), "the 'Beta' node");
      await drop(provider, betaNode, modItem('Delta'));
      expect(order()).toEqual(['Alpha', 'Group A', 'Delta', 'Beta', 'Gamma', 'Group B']);
    });

    it('winning-at-top: drop mod onto empty space appends it to the end', async () => {
      const { provider, order } = makeApplyingProvider();
      provider.toggleViewDirection(); // -> winning-at-top (view == file order)
      await provider.getChildren(); // populate cache
      await drop(provider, undefined, modItem('Alpha'));
      expect(order()).toEqual(['Group A', 'Beta', 'Gamma', 'Group B', 'Delta', 'Alpha']);
    });

    // The whole block is removed before toIndex is counted, so every block member above the
    // target shifts it — otherwise the block is flung to the bottom.
    it('winning-at-top down-drag: drop separator block onto a lower mod lands the block before it', async () => {
      const { provider, order } = makeApplyingProvider();
      provider.toggleViewDirection(); // -> winning-at-top (view == file order)
      const roots = await provider.getChildren();
      const deltaNode = present(roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'Delta'), "the 'Delta' node");
      await drop(provider, deltaNode, sepItem('Group A'));
      expect(order()).toEqual(['Beta', 'Gamma', 'Group B', 'Alpha', 'Group A', 'Delta']);
    });

    // The pinned Overwrite fixture is not a modlist.txt position — a drop
    // onto it must be a no-op, never falling through to "move to end".
    it('drop onto the Overwrite node is a no-op', async () => {
      const { provider, order } = makeApplyingProvider();
      const before = order();
      const overwriteNode = new OverwriteNode(fakeUri('/x'), 1);
      await drop(provider, overwriteNode, modItem('Alpha'));
      expect(order()).toEqual(before);
    });

    // In the default losing-at-top view the file runs opposite to the view, so these assert
    // the on-disk (file) order the drop produces, translated from the intended view position.
    describe('honors the view direction', () => {
      function makeSimpleProvider() {
        let text = '+Winning\n+Middle\n+Losing\n'; // file order: winning-first
        reorderModMock.mockImplementation((_root: string, _profile: string, name: string, idx: number) => {
          text = moveModInText(text, name, idx);
          return Promise.resolve({ applied: true, wrote: true });
        });
        const simpleEntries: ModlistEntry[] = [mod('Winning'), mod('Middle'), mod('Losing')];
        const provider = makeProvider(simpleEntries);
        return { provider, order: () => parseModlist(text).map((e) => e.name) };
      }

      it('sanity: default (losing-at-top) view reverses file order', async () => {
        const { provider } = makeSimpleProvider();
        const labels = (await provider.getChildren()).filter((n): n is ModNode => n instanceof ModNode).map((n) => n.label);
        expect(labels).toEqual(['Losing', 'Middle', 'Winning']);
      });

      // View target ['Losing', 'Winning', 'Middle'] => file order ['Middle','Winning','Losing'].
      it('default (losing-at-top): dropping the winning mod onto the middle row lands it just above that row in the view', async () => {
        const { provider, order } = makeSimpleProvider();
        const middle = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'Middle'), "the 'Middle' node");
        await drop(provider, middle, modItem('Winning'));
        expect(order()).toEqual(['Middle', 'Winning', 'Losing']);
      });

      // View target ['Middle', 'Losing', 'Winning'] => file order ['Winning','Losing','Middle'].
      it('default (losing-at-top): dragging a top (losing) row down onto a lower row lands it just above that row in the view', async () => {
        const { provider, order } = makeSimpleProvider();
        const winning = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'Winning'), "the 'Winning' node");
        await drop(provider, winning, modItem('Losing')); // Losing (view top) dropped onto Winning (view bottom)
        expect(order()).toEqual(['Winning', 'Losing', 'Middle']);
      });

      // View target (winning end, bottom) ['Middle','Winning','Losing'] => file ['Losing','Winning','Middle'].
      it('default (losing-at-top): dropping onto empty space sends the mod to the winning end (bottom of the view)', async () => {
        const { provider, order } = makeSimpleProvider();
        await provider.getChildren(); // populate cache
        await drop(provider, undefined, modItem('Losing'));
        expect(order()).toEqual(['Losing', 'Winning', 'Middle']);
      });

      it('default (losing-at-top): dropping a separator block onto a row lands the block just above it in the view', async () => {
        // Delta is the losing-most row in the default view, so just above it in the view is
        // just after it in the file.
        const { provider, order } = makeApplyingProvider();
        const roots = await provider.getChildren();
        const deltaNode = present(roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'Delta'), "the 'Delta' node");
        await drop(provider, deltaNode, sepItem('Group A'));
        expect(order()).toEqual(['Beta', 'Gamma', 'Group B', 'Delta', 'Alpha', 'Group A']);
      });
    });
  });

  // A failed drop reports on ADR-0019's "explicit action failed" tier, and the tree resyncs
  // against disk rather than showing a phantom move.
  describe('drag-and-drop — failure handling', () => {
    const item = (value: unknown): DataTransferItem => new DataTransferItem(value);
    const token = new FakeCancellationToken();

    // Same shape as the drag-and-drop fixture above: Group A wraps Alpha,
    // Group B wraps Beta/Gamma (a separator's real members precede it),
    // Delta trails the last separator and is ungrouped.
    const dndEntries: ModlistEntry[] = [
      mod('Alpha'),
      sep('Group A'),
      mod('Beta'),
      mod('Gamma'),
      sep('Group B'),
      mod('Delta'),
    ];

    function makeFailingProvider() {
      const reporter = recordingReporter();
      const logs: string[] = [];
      const provider = makeProvider(dndEntries, { log: (m) => logs.push(m), reporter });
      return { provider, reports: reporter.reports, logs };
    }

    async function drop(provider: ModListProvider, target: ModlistNode | undefined, payload: DataTransferItem): Promise<void> {
      const dt = new DataTransfer();
      dt.set('application/vnd.medit.modlist-node', payload);
      await provider.handleDrop(target, dt, token);
    }

    it('a throw from the reorder command reports an error and logs the specific operation', async () => {
      reorderModMock.mockRejectedValue(new Error('disk full'));
      const { provider, reports, logs } = makeFailingProvider();
      const roots = await provider.getChildren();
      const deltaNode = present(roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'Delta'), "the 'Delta' node");
      await drop(provider, deltaNode, item({ kind: 'mod', name: 'Alpha' }));
      expect(reports).toEqual([{ severity: 'error', message: 'Failed to reorder mods.', detail: 'disk full' }]);
      expect(logs.some((l) => l.includes('reorder failed: disk full'))).toBe(true);
    });

    // A refusal (`{ applied: false }`), not a throw, must report the same way.
    it('a refusal from the moveModToSeparator command reports an error and logs the specific operation', async () => {
      moveModToSeparatorMock.mockResolvedValue({ applied: false, refusal: 'disk full' });
      const { provider, reports, logs } = makeFailingProvider();
      const roots = await provider.getChildren();
      const sepNode = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode && n.label === 'Group A'), "the 'Group A' node");
      await drop(provider, sepNode, item({ kind: 'mod', name: 'Alpha' }));
      expect(reports).toEqual([{ severity: 'error', message: 'Failed to reorder mods.', detail: 'disk full' }]);
      expect(logs.some((l) => l.includes('moveModToSeparator failed: disk full'))).toBe(true);
    });

    it('a throw from the reorderSeparatorBlock command reports an error and logs the specific operation', async () => {
      reorderSeparatorBlockMock.mockRejectedValue(new Error('disk full'));
      const { provider, reports, logs } = makeFailingProvider();
      const roots = await provider.getChildren();
      const deltaNode = present(roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'Delta'), "the 'Delta' node");
      await drop(provider, deltaNode, item({ kind: 'separator', name: 'Group A' }));
      expect(reports).toEqual([{ severity: 'error', message: 'Failed to reorder mods.', detail: 'disk full' }]);
      expect(logs.some((l) => l.includes('reorderSeparatorBlock failed: disk full'))).toBe(true);
    });

    it('resyncs the tree after a failed drop, and a successful drop refreshes silently', async () => {
      reorderModMock.mockRejectedValueOnce(new Error('disk full'));
      const { provider: failing, reports: failingReports } = makeFailingProvider();
      let failingFired = false;
      failing.onDidChangeTreeData(() => { failingFired = true; });
      const roots = await failing.getChildren();
      const deltaNode = present(roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'Delta'), "the 'Delta' node");
      await drop(failing, deltaNode, item({ kind: 'mod', name: 'Alpha' }));
      expect(failingFired).toBe(true); // refresh fired to resync against disk
      expect(failingReports).toHaveLength(1);

      const okReporter = recordingReporter();
      const ok = makeProvider(dndEntries, { reporter: okReporter });
      let okFired = false;
      ok.onDidChangeTreeData(() => { okFired = true; });
      const okRoots = await ok.getChildren();
      const okDeltaNode = present(okRoots.find((n): n is ModNode => n instanceof ModNode && n.label === 'Delta'), "the 'Delta' node");
      await drop(ok, okDeltaNode, item({ kind: 'mod', name: 'Alpha' }));
      expect(okFired).toBe(true);
      expect(okReporter.reports).toEqual([]);
    });
  });

  describe('setFilter — reset behaviour', () => {
    it('clearing filter resets groupingOn to true and shows all nodes', async () => {
      const provider = makeProvider([sep('Sep'), mod('Mod')]);
      provider.setFilter('x', false);
      provider.setFilter('', false); // grouping arg ignored when text cleared
      const roots = await provider.getChildren();
      expect(roots.some((n) => n instanceof CountNode)).toBe(true);
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
    it('toggleViewDirection fires a refresh', () => {
      const provider = makeProvider([mod('A')]);
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });

      provider.toggleViewDirection();

      expect(fired).toBe(true);
    });

    it('toggled to winning-at-top: ungrouped first, then separators, all in file order', async () => {
      // Section 1's real members are Alpha/Beta (preceding it); Section 2's
      // are Gamma (preceding it, back to Section 1). Solo A/B trail the last
      // separator and are the truly ungrouped ones.
      const provider = makeProvider([
        mod('Alpha'),
        mod('Beta', false),
        sep('Section 1'),
        mod('Gamma'),
        sep('Section 2'),
        mod('Solo A'),
        mod('Solo B', false),
      ]);
      provider.toggleViewDirection(); // -> winning-at-top (file order)
      const roots = await provider.getChildren();

      expect(roots[0]).toBeInstanceOf(CountNode);
      expect(roots[1]).toBeInstanceOf(ModNode);
      expect(present(roots[1], 'the second root').label).toBe('Solo A');
      expect(roots[2]).toBeInstanceOf(ModNode);
      expect(present(roots[2], 'the third root').label).toBe('Solo B');
      expect(roots[3]).toBeInstanceOf(SeparatorNode);
      expect(present(roots[3], 'the fourth root').label).toBe('Section 1');
      expect(roots[4]).toBeInstanceOf(SeparatorNode);
      expect(present(roots[4], 'the fifth root').label).toBe('Section 2');
    });

    it('toggled to winning-at-top: mods within a separator are in file order', async () => {
      // The separator's members are the entries preceding it.
      const provider = makeProvider([
        mod('First'),
        mod('Second'),
        mod('Third'),
        sep('Section'),
      ]);
      provider.toggleViewDirection(); // -> winning-at-top (file order)
      const roots = await provider.getChildren();
      const sepNode = present(roots.find((n): n is SeparatorNode => n instanceof SeparatorNode), "the sole SeparatorNode");
      const children = await provider.getChildren(sepNode);

      expect(children.map((n) => n.label)).toEqual(['First', 'Second', 'Third']);
    });

    it('toggle applies to flatFilteredRoots (grouping off)', async () => {
      // Group A's real member is Alpha (preceding it); Alpha Child/Alpha
      // Other trail the last separator and are ungrouped.
      const provider = makeProvider([
        mod('Alpha'),
        sep('Group A'),
        mod('Alpha Child'),
        mod('Alpha Other'),
      ]);
      provider.toggleViewDirection(); // -> winning-at-top (file order)
      provider.setFilter('alpha', false);
      const roots = await provider.getChildren();

      // winning-at-top: ungrouped (Alpha Child, Alpha Other) first, then grouped (Alpha).
      expect(roots.map((n) => n.label)).toEqual(['Alpha Child', 'Alpha Other', 'Alpha']);
    });

    it('toggle applies to groupedFilteredRoots (grouping on)', async () => {
      // Group A's real members are Alpha Child/Alpha Other (preceding it);
      // Alpha trails the last separator and is ungrouped.
      const provider = makeProvider([
        mod('Alpha Child'),
        mod('Alpha Other'),
        sep('Group A'),
        mod('Alpha'),
      ]);
      provider.toggleViewDirection(); // -> winning-at-top (file order)
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();

      // winning-at-top: ungrouped (Alpha) first, then grouped (Group A).
      expect(roots[0]).toBeInstanceOf(ModNode);
      expect(present(roots[0], 'the first root').label).toBe('Alpha');
      expect(roots[1]).toBeInstanceOf(SeparatorNode);
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
    it('flipping view direction (toggleViewDirection) never changes a conflict\'s winner', async () => {
      const instance = new FakeInstance(valueOf([mod('ModA'), mod('ModB')], { modStatuses: conflictStatuses() }));
      const provider = makeProvider([], { instance });
      const before = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA'), "the 'ModA' node");
      expect(before.tooltip).toContain('winner: ModB');

      provider.toggleViewDirection(); // presentation flip only — losing-at-top -> winning-at-top
      const afterFlip = present((await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA'), "the 'ModA' node");
      expect(afterFlip.tooltip).toContain('winner: ModB');
      expect(afterFlip.iconPath).toEqual(before.iconPath);

      provider.toggleViewDirection(); // flip back
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

    it('carries a missing-mod status through unchanged', async () => {
      const statuses = new Map<string, ModStatusResult>([
        ['ModA', { status: { kind: 'missingMod' }, conflictLines: [] }],
      ]);
      const provider = makeProvider([mod('ModA')], {
        instance: new FakeInstance(valueOf([mod('ModA')], { modStatuses: statuses })),
      });
      const roots = await provider.getChildren();
      const modA = present(roots.find((n): n is ModNode => n instanceof ModNode), "the sole ModNode");

      expect(modA.iconPath).toEqual({ id: 'error' });
      expect(modA.tooltip).toContain('Missing mod');
    });
  });

  // A pinned Overwrite leaf, last row of the tree, outside separator grouping. The count is a
  // plain field of the Instance value — no disk, no temporary instance.
  describe('Overwrite row', () => {
    const entries = (): ModlistEntry[] => [mod('Alpha'), sep('Group A'), mod('Beta')];

    it('appends an Overwrite node as the very last root when the value carries a non-zero count', async () => {
      const provider = makeProvider(entries(), {
        instance: new FakeInstance(valueOf(entries(), { overwriteFileCount: 3 })),
      });
      const roots = await provider.getChildren();

      const last = roots[roots.length - 1];
      expect(last).toBeInstanceOf(OverwriteNode);
      // Outside grouping: exactly one, and it is not a child of any separator.
      expect(roots.filter((n) => n instanceof OverwriteNode)).toHaveLength(1);
    });

    it('omits the Overwrite node when the value carries a zero count', async () => {
      const provider = makeProvider(entries()); // overwriteFileCount defaults to 0
      const roots = await provider.getChildren();
      expect(roots.some((n) => n instanceof OverwriteNode)).toBe(false);
    });

    it('is read-only: no checkbox, a reveal command, contextValue, and a count+help tooltip', async () => {
      const provider = makeProvider(entries(), {
        instance: new FakeInstance(valueOf(entries(), { overwriteFileCount: 2 })),
      });
      const roots = await provider.getChildren();
      const node = present(roots.find((n): n is OverwriteNode => n instanceof OverwriteNode), "the sole OverwriteNode");

      expect(node.label).toBe('Overwrite');
      expect(node.checkboxState).toBeUndefined();
      expect(node.contextValue).toBe('overwrite');
      expect(present(node.command, "the OverwriteNode's reveal command").command).toBe('modbench.modList.overwrite.reveal');
      const tooltip = node.tooltip;
      if (typeof tooltip !== 'string') throw new Error('expected OverwriteNode.tooltip to be a string');
      expect(tooltip).toContain('2');
      expect(tooltip).toMatch(/reassign|clear/i);
    });

    // instanceRoot's only remaining use: the pinned row's resourceUri (Explorer reveal / the
    // decoration provider's key) — never a disk read.
    it('builds the Overwrite node\'s resourceUri by joining the injected instanceRoot with "overwrite"', async () => {
      const provider = makeProvider(entries(), {
        instance: new FakeInstance(valueOf(entries(), { overwriteFileCount: 1 })),
        instanceRoot: '/my/mo2/instance',
      });
      const roots = await provider.getChildren();
      const node = present(roots.find((n): n is OverwriteNode => n instanceof OverwriteNode), "the sole OverwriteNode");
      expect(node.resourceUri.fsPath).toBe('/my/mo2/instance/overwrite');
      expect(typeof node.resourceUri.toString).toBe('function');
    });

    it('stays last even under descending sort (outside all grouping)', async () => {
      const provider = makeProvider(entries(), {
        instance: new FakeInstance(valueOf(entries(), { overwriteFileCount: 1 })),
      });
      provider.toggleViewDirection();
      const roots = await provider.getChildren();
      expect(roots[roots.length - 1]).toBeInstanceOf(OverwriteNode);
    });
  });
});
