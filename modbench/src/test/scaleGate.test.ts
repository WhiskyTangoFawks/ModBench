import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => (await import('./fileSystemCalls')).countingCalls(await importOriginal()));
vi.mock('node:fs/promises', async (importOriginal) => (await import('./fileSystemCalls')).countingCalls(await importOriginal()));

vi.mock('vscode', async () => {
  const { fakeVscodeModule } = await import('./mo2/fakeVscodeWatcher');
  const {
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri, FakeDiagnosticCollection, MarkdownString, DataTransferItem,
    DiagnosticSeverity, Diagnostic, Range,
  } = await import('./vscodeMock');
  const { FakeInputBox, FakeTreeView } = await import('../drivingLib/test/nameFilterViewHarness');
  const registered = () => ({ dispose: () => undefined });
  return {
    ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri, MarkdownString, DataTransferItem,
    DiagnosticSeverity, Diagnostic, Range, CodeActionKind: { QuickFix: 'quickfix' }, StatusBarAlignment: { Left: 1, Right: 2 },
    Disposable: class { constructor(readonly dispose: () => void) {} static from(...all: { dispose: () => unknown }[]) { return { dispose: () => { for (const each of all) each.dispose(); } }; } },
    window: {
      registerFileDecorationProvider: registered, registerCustomEditorProvider: registered,
      createTreeView: (_id: string, { treeDataProvider, ...options }: { treeDataProvider: never }) => new FakeTreeView(treeDataProvider, options),
      createInputBox: () => new FakeInputBox(),
      createStatusBarItem: () => ({ text: '', show: () => undefined, hide: () => undefined, dispose: () => undefined }),
    },
    commands: { registerCommand: registered, executeCommand: () => Promise.resolve() },
    languages: { createDiagnosticCollection: () => new FakeDiagnosticCollection(), registerCodeLensProvider: registered, registerCodeActionsProvider: registered },
    tasks: { registerTaskProvider: registered },
  };
});

import { A_FILE_A_RULE_READS_REWRITTEN, A_GESTURE_WRITING_A_LOOSE_FILE, A_NEW_LOOSE_FILE, A_NEW_LOOSE_FILE_UNDER_A_FILE_RULE, A_RECORD_WRITTEN, IN_MODS, IN_PLUGINS, NOTHING_WRITTEN, REWRITTEN_WITH_ITS_OWN_BYTES, costOf, type Cost, type Gesture } from './scaleGate';

const SMALL = 3;
const LARGE = 12;

type Measured = Awaited<ReturnType<typeof costOf>>;
const measured = new Map<Gesture, Promise<[Measured, Measured]>>();
function smallThenLarge(gesture: Gesture): Promise<[Measured, Measured]> {
  const costs = measured.get(gesture) ?? costOf(SMALL, gesture).then(async (small) => [small, await costOf(LARGE, gesture)] as [Measured, Measured]);
  measured.set(gesture, costs);
  return costs;
}

const at = (cost: Cost, layers: readonly (keyof Cost)[]): Partial<Cost> => Object.fromEntries(layers.map((layer) => [layer, cost[layer]]));

const CHANGED = ['read', 'derived', 'subscribers', 'mEdit'] as const;
const SHOWN = [...CHANGED, 'views'] as const;
const SETTLED = [...SHOWN, 'settling'] as const;

describe('a change costs the same on a small and a large instance (ADR-0029, Consequences, bullet 5)', () => {
  it.each<{ change: Gesture; layers: readonly (keyof Cost)[] }>([
    { change: A_NEW_LOOSE_FILE, layers: CHANGED },
    { change: A_RECORD_WRITTEN, layers: SHOWN },
    { change: A_NEW_LOOSE_FILE_UNDER_A_FILE_RULE, layers: SHOWN },
    { change: A_FILE_A_RULE_READS_REWRITTEN, layers: SETTLED },
    { change: A_GESTURE_WRITING_A_LOOSE_FILE, layers: SETTLED },
  ])('$change.name', async ({ change, layers }) => {
    const [small, large] = await smallThenLarge(change);

    expect(at(large, layers)).toEqual(at(small, layers));
  });
});

describe('a new loose file in one mod', () => {
  it('derives only the facts that hold the file, so the load order snapshot mEdit is handed stays as it was (commands.md, Commands Modbench runs itself, row 1)', async () => {
    const [{ derivedIn }] = await smallThenLarge(A_NEW_LOOSE_FILE);

    expect(Object.keys(derivedIn).filter((fact) => (derivedIn[fact] ?? 0) > 0)).toEqual(['files', 'filesByMod', 'stackedCopies']);
  });
});

const A_CHECK_OF_THE_DISK: Gesture = { name: 'a check of the disk', make: async ({ instance }) => { await instance.refresh(); return 0; } };

describe('a change shows in the views at the rows it touches, on a small and a large instance (common.md, A view, story 13)', () => {
  it.each([
    ['a new loose file in one mod tells neither, whose files it does not touch', A_NEW_LOOSE_FILE, 0],
    ['a check of the disk tells each once', A_CHECK_OF_THE_DISK, 1],
  ])('the symbols and deploy\'s problems: %s', async (_case, change, told) => {
    const [small, large] = await smallThenLarge(change);

    expect([small.told, large.told]).toEqual([{ symbols: told, deployProblems: told }, { symbols: told, deployProblems: told }]);
  });

  it('a new loose file in one mod asks the Mods and Plugins views the same, and the conflict table of another mod nothing', async () => {
    const [small, large] = await smallThenLarge(A_NEW_LOOSE_FILE);

    expect(large.viewsIn.Mods).toBe(small.viewsIn.Mods);
    expect(large.viewsIn.Plugins).toBe(small.viewsIn.Plugins);
    expect([small.viewsIn.Conflicts, large.viewsIn.Conflicts]).toEqual([0, 0]);
  });

  it('a file a rule reads, rewritten in place, draws again the row of the plugin the rule judges, the same on both', async () => {
    const [small, large] = await smallThenLarge(A_FILE_A_RULE_READS_REWRITTEN);

    expect([small.viewsIn.Plugins > 0, large.viewsIn.Plugins]).toEqual([true, small.viewsIn.Plugins]);
  });
});

describe('a gesture into one mod costs the same whatever that mod holds (ADR-0029, Consequences, bullet 5)', () => {
  it('at every layer', async () => {
    const layers = [...SETTLED, 'lookups', 'rows'] as const;
    const small = await costOf(SMALL, { ...A_GESTURE_WRITING_A_LOOSE_FILE, writtenModFiles: 3 });
    const large = await costOf(SMALL, { ...A_GESTURE_WRITING_A_LOOSE_FILE, writtenModFiles: 300 });

    expect(at(large, layers)).toEqual(at(small, layers));
  });
});

describe('a read that finds nothing new is no change', () => {
  it.each([NOTHING_WRITTEN, REWRITTEN_WITH_ITS_OWN_BYTES])('$name reads the same on both, and derives, tells, asks and draws nothing', async (change) => {
    const [small, large] = await smallThenLarge(change);

    expect(large.read).toBe(small.read);
    expect(at(large, ['derived', 'subscribers', 'mEdit', 'views'])).toEqual({ derived: 0, subscribers: 0, mEdit: 0, views: 0 });
  });
});

describe('a gesture in a view costs what it shows, on a small and a large instance', () => {
  const perRow = (cost: Measured): Partial<Cost> => Object.fromEntries(SHOWN.map((layer) => [layer, cost[layer] / cost.shown]));

  it.each([...Object.values(IN_MODS), ...Object.values(IN_PLUGINS)])('$name', async (gesture) => {
    const [small, large] = await smallThenLarge(gesture);

    expect(small.shown).toBeGreaterThan(0);
    expect(perRow(large)).toEqual(perRow(small));
  });
});
