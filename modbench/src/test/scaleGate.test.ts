import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => (await import('./fileSystemCalls')).countingCalls(await importOriginal()));
vi.mock('node:fs/promises', async (importOriginal) => (await import('./fileSystemCalls')).countingCalls(await importOriginal()));

vi.mock('vscode', async () => {
  const { fakeVscodeModule } = await import('./mo2/fakeVscodeWatcher');
  const { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri, FakeDiagnosticCollection } = await import('./vscodeMock');
  return {
    ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri,
    window: { registerFileDecorationProvider: () => ({ dispose: () => undefined }), registerCustomEditorProvider: () => ({ dispose: () => undefined }) },
    commands: { registerCommand: () => ({ dispose: () => undefined }) },
    languages: { createDiagnosticCollection: () => new FakeDiagnosticCollection() },
    tasks: { registerTaskProvider: () => ({ dispose: () => undefined }) },
  };
});

import { A_FILE_A_RULE_READS_REWRITTEN, A_GESTURE_WRITING_A_LOOSE_FILE, filesNamed, A_NEW_LOOSE_FILE, A_NEW_LOOSE_FILE_UNDER_A_FILE_RULE, A_RECORD_WRITTEN, IN_MODS, IN_PLUGINS, NOTHING_WRITTEN, REWRITTEN_WITH_ITS_OWN_BYTES, costOf, type Cost, type Gesture } from './scaleGate';

describe('a change costs the same on a small and a large instance', () => {
  it.each<{ change: Gesture; layer: keyof Cost }>([
    ...[A_NEW_LOOSE_FILE, NOTHING_WRITTEN, REWRITTEN_WITH_ITS_OWN_BYTES].map((change) => ({ change, layer: 'read' as const })),
    { change: A_NEW_LOOSE_FILE, layer: 'derived' },
    ...(['read', 'derived', 'subscribers', 'mEdit', 'views'] as const).flatMap((layer) => [A_RECORD_WRITTEN, A_NEW_LOOSE_FILE_UNDER_A_FILE_RULE].map((change) => ({ change, layer }))),
    ...(['read', 'derived', 'subscribers', 'mEdit', 'views', 'settling'] as const).flatMap((layer) => [A_FILE_A_RULE_READS_REWRITTEN, A_GESTURE_WRITING_A_LOOSE_FILE].map((change) => ({ change, layer }))),
    { change: A_NEW_LOOSE_FILE, layer: 'subscribers' },
    { change: A_NEW_LOOSE_FILE, layer: 'mEdit' },
  ])('$change.name, at the $layer layer', async ({ change, layer }) => {
    const small = await costOf(3, change);
    const large = await costOf(60, change);

    expect(large[layer]).toBe(small[layer]);
  });
});

describe('a new loose file in one mod', () => {
  it('derives only the facts that hold the file, so the load order snapshot mEdit is handed stays as it was (commands.md, Commands Modbench runs itself, row 1)', async () => {
    const { derivedIn } = await costOf(3, A_NEW_LOOSE_FILE);

    expect(Object.keys(derivedIn).filter((fact) => (derivedIn[fact] ?? 0) > 0)).toEqual(['files', 'filesByMod', 'stackedCopies']);
  });
});

describe('a change shows in the views at the rows it touches, on a small and a large instance (common.md, A view, story 13)', () => {
  it.each([
    ['a new loose file in one mod tells neither, whose files it does not touch', A_NEW_LOOSE_FILE, 0],
    ['a check of the disk tells each once', { name: 'a check of the disk', make: async ({ instance }) => { await instance.refresh(); return 0; } } satisfies Gesture, 1],
  ])('the symbols and deploy\'s problems: %s', async (_case, change, told) => {
    const small = await costOf(3, change);
    const large = await costOf(60, change);

    expect([small.told, large.told]).toEqual([{ symbols: told, deployProblems: told }, { symbols: told, deployProblems: told }]);
  });

  it('a new loose file in one mod asks the Mods and Plugins views the same, and the conflict table of another mod nothing', async () => {
    const small = await costOf(3, A_NEW_LOOSE_FILE);
    const large = await costOf(60, A_NEW_LOOSE_FILE);

    expect(large.viewsIn.Mods).toBe(small.viewsIn.Mods);
    expect(large.viewsIn.Plugins).toBe(small.viewsIn.Plugins);
    expect([small.viewsIn.Conflicts, large.viewsIn.Conflicts]).toEqual([0, 0]);
  });

  it('a file a rule reads, rewritten in place, draws again the row of the plugin the rule judges, the same on both', async () => {
    const small = await costOf(3, A_FILE_A_RULE_READS_REWRITTEN);
    const large = await costOf(60, A_FILE_A_RULE_READS_REWRITTEN);

    expect([small.viewsIn.Plugins > 0, large.viewsIn.Plugins]).toEqual([true, small.viewsIn.Plugins]);
  });
});

describe('a gesture into one mod costs the same whatever that mod holds (ADR-0029, Consequences, bullet 5)', () => {
  const into = (files: number): Gesture => ({ ...A_GESTURE_WRITING_A_LOOSE_FILE, writtenModFiles: files });

  it.each(['read', 'derived', 'subscribers', 'mEdit', 'views', 'settling', 'lookups', 'rows'] as const)('at the %s layer', async (layer) => {
    const small = await costOf(3, into(3));
    const large = await costOf(3, into(300));

    expect(large[layer]).toBe(small[layer]);
  });
});

describe('a read naming many files, as a deploy names what it wrote (common.md, A gesture that writes, story 4)', () => {
  it('tests the files kept against the paths named at the same cost whatever the instance holds', async () => {
    const byNamed = async (mods: number): Promise<number> => (await costOf(mods, filesNamed(200))).scans - (await costOf(mods, filesNamed(1))).scans;

    expect(await byNamed(60)).toBe(await byNamed(3));
  });
});

describe('a read that finds nothing new is no change', () => {
  it.each<{ change: Gesture; layer: keyof Cost }>(
    [NOTHING_WRITTEN, REWRITTEN_WITH_ITS_OWN_BYTES].flatMap((change) => (['derived', 'subscribers', 'mEdit', 'views'] as const).map((layer) => ({ change, layer }))),
  )('$change.name, at the $layer layer', async ({ change, layer }) => {
    const cost = await costOf(60, change);

    expect(cost[layer]).toBe(0);
  });
});

describe('a gesture in a view costs what it shows, on a small and a large instance', () => {
  const layers: (keyof Cost)[] = ['read', 'derived', 'subscribers', 'mEdit', 'views'];
  it.each<{ gesture: Gesture; layer: keyof Cost }>(
    [...Object.values(IN_MODS), ...Object.values(IN_PLUGINS)].flatMap((gesture) => layers.map((layer) => ({ gesture, layer }))),
  )('$gesture.name, at the $layer layer', async ({ gesture, layer }) => {
    const small = await costOf(3, gesture);
    const large = await costOf(60, gesture);

    expect(small.shown).toBeGreaterThan(0);
    expect(large[layer] / large.shown).toBe(small[layer] / small.shown);
  });
});
