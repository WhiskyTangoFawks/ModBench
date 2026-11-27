import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { DiagnosticSeverity, host, Uri } from './vscodeHost';
import { deferred, factsOver, settle, type Shown } from './pluginsOver';
import type { PluginDiagnosisReport, PluginLoadFailure, PluginMetadata } from '../../client';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { settled } from '../../test/eventually';

const A = { name: 'A.esp', origin: 'SomeMod' };
const B = { name: 'B.esp', origin: 'SomeMod' };

type Facts = ReturnType<typeof factsOver>;
type Tell = (facts: Facts) => Promise<void>;
type Scene = readonly [readonly Shown[], Tell, string?];

const held = (overrides: Partial<PluginMetadata> = {}): PluginMetadata => pluginMetadataFixture({ name: 'A.esp', isCompiledPlugin: true, ...overrides });
const failure = (reason: string, address = A): PluginLoadFailure => ({ ...address, reason });
const diagnosis = (text: string, address = A): PluginDiagnosisReport => ({ plugin: address.name, origin: address.origin, text });

const CHANGED_TEXT = 'Changed outside Modbench: its bytes differ from what Modbench last wrote.';
const missingMaster = (ghost: string) => `"${ghost}" is a master of "A.esp", and is missing or not active.`;
const MASTER_FLAG_LINE = 'Error: "A.esp" loads as a master, by its master flag or its extension, so the game loads it before "B.esp", not where plugins.txt lists it.';
const LOAD_AFTER_LINE = 'Warning: "A.esp" loads before "B.esp", and should load after it.';
const A_AFTER_B = "plugins:\n  - name: 'A.esp'\n    after: ['B.esp']\n";

const nothing: Scene = [[A], () => Promise.resolve()];
const reconciledWith = (overrides: Partial<PluginMetadata>): Scene => [[A], (facts) => facts.reconciled([held(overrides)])];
const failed: Scene = [[A], (facts) => facts.reconciled([], { failures: [failure('Malformed record')] })];
const lackingMasters = (...ghosts: string[]): Scene => [[A], (facts) => facts.reconciled([held({ masters: ghosts })])];
const masterFlagAfterB = (overrides: Partial<PluginMetadata> = {}): Scene => [[B, A], (facts) => facts.reconciled([held({ isMaster: true, ...overrides }), held(B)])];
const loadsBeforeB: Scene = [[A, B], (facts) => facts.reconciled([held(), held(B)]), A_AFTER_B];
const unreadable = reconciledWith({ hasParseFailure: true });
const sourceUnreadable = reconciledWith({ pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } });
const sourceUnreadableForGood = reconciledWith({ pluginSourceUnreadable: { reason: 'Twin folders.', decompileRepairs: false } });
const changed: Scene = [[A], (facts) => facts.reconciled([held()], { changedOutside: [A] })];
const malformed: Scene = [[A], (facts) => facts.reconciled([held()], { diagnoses: [diagnosis('first'), diagnosis('second')] })];

async function over([shown, tell, masterlist]: Scene): Promise<Facts> {
  const facts = factsOver(shown, { masterlist });
  await tell(facts);
  return facts;
}

const rowOf = async (facts: Facts, address = A) => {
  const row = await facts.row(address.name, address.origin);
  if (row === undefined) throw new Error(`no row of ${address.name}`);
  return row;
};

const HELD_ELSEWHERE = { kind: 'heldElsewhere', message: 'another window holds this instance' } as const;
const FAILED_INDEX = { kind: 'failed', message: 'the record index threw' } as const;
const RECORDS = { kind: 'records' } as const;
const INDEXING = { kind: 'indexing' } as const;
const errorOf = (message: string) => ({ kind: 'error', message }) as const;
const then = (...steps: Tell[]): Tell => async (facts) => { for (const step of steps) await step(facts); };

describe('the sorting rules are judged once a reconcile completes (plugins.md, A row, Plugin)', () => {
  it.each<[string, Tell, string | undefined]>([
    ['while indexing', () => Promise.resolve(), 'Still indexing…'],
    ['when the snapshot failed', (facts) => facts.refused(FAILED_INDEX), FAILED_INDEX.message],
    ['when another window holds the record index', (facts) => facts.refused(HELD_ELSEWHERE), HELD_ELSEWHERE.message],
    ['when mEdit is unreachable', (facts) => facts.unreachable(), 'mEdit is disconnected.'],
    ['after a reconcile', (facts) => facts.reconciled([held()]), undefined],
    ['while a later snapshot indexes', then((facts) => facts.reconciled([held()]), (facts) => facts.indexed({ indexed: [A] })), undefined],
  ])('says why they are not judged %s', async (_label, tell, reason) => {
    const facts = await over([[A], tell]);

    expect(facts.agent.sortingNotJudged()).toBe(reason);
  });
});

describe('the tooltip names the origin (plugins.md, A row, Plugin, Tooltip)', () => {
  it('names the game folder as the user reads it', async () => {
    const facts = factsOver([{ name: 'A.esp', origin: 'Data/' }]);

    expect((await facts.row('A.esp', 'Data/'))?.tooltip).toEqual(['A.esp', 'the game folder']);
  });
});

describe('the status table (plugins.md, A row, Plugin)', () => {
  it.each<[string, Scene, string | undefined, string | undefined, string[]]>([
    ['nothing', nothing, undefined, undefined, []],
    ['failed to read', failed, 'error', 'failed to read', ['Failed to read: Malformed record']],
    ['one sorting error', lackingMasters('Ghost.esm'), 'error', '1 error', [`Error: ${missingMaster('Ghost.esm')}`]],
    ['two sorting errors', lackingMasters('Ghost.esm', 'Off.esm'), 'error', '2 errors', [`Error: ${missingMaster('Ghost.esm')}`, `Error: ${missingMaster('Off.esm')}`]],
    ['no sorting errors', lackingMasters(), undefined, undefined, []],
    ['one sorting error from the game moving it', masterFlagAfterB(), 'error', '1 error', [MASTER_FLAG_LINE]],
    ['one sorting warning', loadsBeforeB, 'warning', '1 warning', [LOAD_AFTER_LINE]],
    ['unreadable records', unreadable, 'error', 'unreadable records', ['This plugin holds a record that could not be read into its document.']],
    ['plugin source unreadable', sourceUnreadable, 'error', 'plugin source unreadable',
      ['read-only', 'Plugin source unreadable: Its folder is gone. Its records are those of its plugin file, until decompile writes its source.']],
    ['plugin source unreadable that decompile does not repair', sourceUnreadableForGood, 'error', 'plugin source unreadable',
      ['read-only', 'Plugin source unreadable: Twin folders. Its records are those of its plugin file.']],
    ['changed outside Modbench', changed, 'warning', 'changed outside Modbench', [CHANGED_TEXT]],
    ['malformed', malformed, 'warning', 'malformed', ['Malformed: first; second']],
  ])('%s', async (_label, scene, icon, words, tooltipLines) => {
    const facts = await over(scene);

    expect(await rowOf(facts)).toMatchObject({ icon, description: words, tooltip: ['A.esp', 'SomeMod', ...tooltipLines] });
  });

  it('sets the icon by the first status that holds, an error landed after a warning', async () => {
    const facts = await over(malformed);

    await facts.reconciled([], { failures: [failure('Malformed record')], diagnoses: [diagnosis('first')] });

    expect((await rowOf(facts)).icon).toBe('error');
  });

  it('lists every status in the spec order whatever the order they landed in', async () => {
    const facts = factsOver([B, A], { masterlist: A_AFTER_B });

    await facts.reconciled([
      held({ isMaster: true, masters: ['Ghost.esm'], hasParseFailure: true, pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } }),
      held(B),
    ], { failures: [failure('Malformed record')], changedOutside: [A], diagnoses: [diagnosis('first'), diagnosis('second')] });

    expect((await rowOf(facts)).description)
      .toBe('failed to read, 2 errors, unreadable records, plugin source unreadable, changed outside Modbench, malformed, 1 warning');
  });

  it('names a master that loads after its dependant on both plugins', async () => {
    const late = { name: 'Late.esp', origin: 'SomeMod' };
    const facts = factsOver([A, late]);

    await facts.reconciled([held({ masters: ['Late.esp'] }), held(late)]);

    const line = 'Error: "Late.esp" is a master of "A.esp", so it must load before it.';
    expect([(await rowOf(facts)).tooltip, (await rowOf(facts, late)).tooltip]).toEqual([expect.arrayContaining([line]), expect.arrayContaining([line])]);
  });

  it('raises an Error, on a blueprint line listed before a plugin that is not one, that the game moves it, and on no blueprint plugin with no line', async () => {
    const blueprint = { name: 'Blueprint.esm', origin: 'SomeMod' };
    const ship = { name: 'Ship.esm', origin: 'SomeMod' };
    const facts = factsOver([ship, A, { ...blueprint, noLine: true }]);

    await facts.reconciled([held(), held({ ...blueprint, isMaster: true, isBlueprint: true }), held({ ...ship, isMaster: true, isBlueprint: true })]);

    expect(facts.agent.brokenRules().map(({ plugins }) => plugins.map(({ filename }) => filename))).toEqual([['Ship.esm']]);
  });

  it('offers a move judged on the order the game loads, where a plugin it loads with no line hoists the master the move passes', async () => {
    const creation = { name: 'Creation.esm', origin: 'SomeMod' };
    const q = { name: 'Q.esp', origin: 'SomeMod' };
    const m = { name: 'M.esp', origin: 'SomeMod' };
    const facts = factsOver([{ ...creation, noLine: true }, A, q, m]);

    await facts.reconciled([held({ masters: ['M.esp'] }), held(q), held({ ...m, masters: ['Q.esp'] }), held({ ...creation, isMaster: true, masters: ['Q.esp'] })]);

    expect(facts.agent.suggestedMoves().map(({ mover, drop }) => [mover.name, drop])).toEqual([['M.esp', { kind: 'before', name: 'A.esp' }]]);
  });

  it('judges LOOT\'s rules on the order the game loads, so a plugin listed before one it loads after keeps the rule where the game moves that one', async () => {
    const late = { name: 'Late.esm', origin: 'SomeMod' };
    const facts = factsOver([A, late], { masterlist: "plugins:\n  - name: 'A.esp'\n    after: ['Late.esm']\n" });

    await facts.reconciled([held(), held({ ...late, isMaster: true })]);

    expect(facts.agent.brokenRules().map(({ level }) => level)).toEqual(['error']);
  });

  it('carries the read-only line between the origin and the status lines', async () => {
    const facts = await over(reconciledWith({ isImmutable: true, masters: ['Ghost.esm'] }));

    expect((await rowOf(facts)).tooltip).toEqual(['A.esp', 'SomeMod', 'read-only', `Error: ${missingMaster('Ghost.esm')}`]);
  });

  it.each([
    ['a plugin named in no answer', B],
    ['the same plugin file name of another origin', { name: 'A.esp', origin: 'OtherMod' }],
  ])('shows nothing on %s', async (_label, address) => {
    const facts = factsOver([A, address]);

    await facts.reconciled([held({ masters: ['Ghost.esm'], hasParseFailure: true })], {
      failures: [failure('Malformed record')], changedOutside: [A], diagnoses: [diagnosis('first')],
    });

    expect((await rowOf(facts, address)).description).toBeUndefined();
  });
});

describe('plugins that differ only in case', () => {
  it('shows each its own reason for failing to read', async () => {
    const upper = { name: 'Foo.esp', origin: 'SomeMod' };
    const lower = { name: 'foo.esp', origin: 'SomeMod' };
    const facts = factsOver([upper, lower]);

    await facts.reconciled([], { failures: [failure('differs from foo.esp', upper), failure('differs from Foo.esp', lower)] });

    expect([(await rowOf(facts, upper)).tooltip, (await rowOf(facts, lower)).tooltip]).toEqual([
      expect.arrayContaining(['Failed to read: differs from foo.esp']), expect.arrayContaining(['Failed to read: differs from Foo.esp']),
    ]);
    expect([await facts.expansion('Foo.esp'), await facts.expansion('foo.esp')]).toEqual([errorOf('differs from foo.esp'), errorOf('differs from Foo.esp')]);
  });
});

describe('which statuses stay and which land (plugins.md, A row, bullets)', () => {
  it('shows no sorting status before a reconcile has judged the order, which is not no broken rules', async () => {
    const facts = factsOver([A]);
    await facts.indexed({ indexed: [A] });

    await facts.changed([held({ masters: ['Ghost.esm'] })]);

    expect((await rowOf(facts)).description).toBeUndefined();
  });

  it.each<[string, Tell]>([
    ['a tick that indexes the plugin', (facts) => facts.indexed({ indexed: [A] })],
    ['a re-read that changes nothing the sorting rules judge', (facts) => facts.changed([held({ masters: ['Ghost.esm'], isImmutable: true })], [A])],
  ])('keeps the last sorting statuses through %s', async (_, through) => {
    const facts = await over(lackingMasters('Ghost.esm'));

    await through(facts);

    expect((await rowOf(facts)).tooltip).toContain(`Error: ${missingMaster('Ghost.esm')}`);
  });

  it('keeps a failed plugin failed through a tick that does not name it, until a reconcile lands', async () => {
    const facts = await over(failed);

    await facts.indexed();
    const throughTheTick = (await rowOf(facts)).description;
    await facts.reconciled([held()]);

    expect([throughTheTick, (await rowOf(facts)).description]).toEqual(['failed to read', undefined]);
  });

  it('adds each tick\'s failures to the last, for the row, and replaces them for the expansion', async () => {
    const C = { name: 'C.esp', origin: 'SomeMod' };
    const facts = factsOver([A, B, C]);

    await facts.indexed({ failures: [failure('first')] });
    await facts.indexed({ indexed: [C], failures: [failure('second', B)] });

    expect([(await rowOf(facts)).description, (await rowOf(facts, B)).description]).toEqual(['failed to read', 'failed to read']);
    expect([await facts.expansion('A.esp'), await facts.expansion('B.esp')]).toEqual([INDEXING, errorOf('second')]);
  });

  it('expands a plugin failed in the last reconcile to its reason, and one that failed only before it to nothing', async () => {
    const facts = factsOver([A]);
    await facts.indexed({ failures: [failure('first')] });
    await facts.reconciled([]);
    const afterTheReconcile = await facts.expansion('A.esp');

    await facts.reconciled([], { failures: [failure('second')] });

    expect([afterTheReconcile, await facts.expansion('A.esp')]).toEqual([INDEXING, errorOf('second')]);
  });

  it('keeps the last diagnoses until the next scan lands, and a scan that finds nothing clears them', async () => {
    const facts = await over([[A], (made) => made.reconciled([held()], { diagnoses: [diagnosis('some')] })]);
    const scanned = (await rowOf(facts)).description;

    await facts.reconciled([held()], { diagnoses: [] });

    expect([scanned, (await rowOf(facts)).description]).toEqual(['malformed', undefined]);
  });

  it('replaces what a plugin\'s last read said with its next, and leaves other plugins\' alone', async () => {
    const C = { name: 'C.esp', origin: 'OtherMod' };
    const facts = factsOver([A, C]);
    await facts.reconciled([held(), held(C)], { changedOutside: [A, C] });

    await facts.changed([held(), held(C)], undefined, [C]);

    expect([(await rowOf(facts)).description, (await rowOf(facts, C)).description]).toEqual([undefined, 'changed outside Modbench']);
  });
});

describe('the Problems panel reads the answers the rows read', () => {
  const problems = (collection: string) => host.problems(collection).map(([path, shown]) => [path, shown.map(({ message }) => message)]);

  it('lists an error for each plugin whose plugin source is unreadable, as the reconcile answered, and whether decompile repairs it', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([
      held({ pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } }),
      held({ ...B, pluginSourceUnreadable: { reason: 'Twin folders.', decompileRepairs: false } }),
    ]);
    const unreadableThen = host.problems('modbench-source-unreadable').map(([path, shown]) => [path, shown.map(({ message, severity, code }) => [message, severity, code !== undefined])]);

    await facts.reconciled([held()]);

    expect([unreadableThen, problems('modbench-source-unreadable')]).toEqual([[
      ['/mods/SomeMod/A.esp', [['Plugin source unreadable: Its folder is gone.', DiagnosticSeverity.Error, true]]],
      ['/mods/SomeMod/B.esp', [['Plugin source unreadable: Twin folders.', DiagnosticSeverity.Error, false]]],
    ], []]);
  });

  it('lists each broken sorting rule on every plugin it names, at its level, as the reconcile judged', async () => {
    await over(masterFlagAfterB({ masters: ['Ghost.esm'] }));

    expect([problems('modbench-sorting-errors'), problems('modbench-sorting-warnings')]).toEqual([
      [['/mods/SomeMod/A.esp', [missingMaster('Ghost.esm'), MASTER_FLAG_LINE.replace('Error: ', '')]]], [],
    ]);
  });

  it('lists the diagnosis of each failed read that carries one, on its plugin, as the reconcile answered', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([], { failures: [{ ...failure('Could not read (duplicate FormKey).'), diagnosis: 'duplicate FormKey' }, failure('Malformed record', B)] });
    const failedThen = problems('modbench-failed-to-read');

    await facts.reconciled([]);

    expect([failedThen, problems('modbench-failed-to-read')]).toEqual([[['/mods/SomeMod/A.esp', ['duplicate FormKey']]], []]);
  });
});

describe('what a row states about its plugin', () => {
  const flags = ['compiledPlugin', 'nonCompiledPlugin', 'editable', 'malformed', 'suggestedMove'];
  const flagsOf = async (facts: Facts, address = A) => (await rowOf(facts, address)).context.filter((word) => flags.includes(word));

  it.each<[string, Scene, string[]]>([
    ['nothing before mEdit answers', nothing, []],
    ['a plugin with no source', reconciledWith({ isCompiledPlugin: false }), ['nonCompiledPlugin']],
    ['an editable compiled plugin', reconciledWith({ isCompiledPlugin: true }), ['compiledPlugin', 'editable']],
    ['a read-only compiled plugin', reconciledWith({ isCompiledPlugin: true, isImmutable: true }), ['compiledPlugin']],
    ['a compiled plugin whose plugin source is unreadable', sourceUnreadable, ['compiledPlugin']],
  ])('%s', async (_label, scene, stated) => {
    expect(await flagsOf(await over(scene))).toEqual(stated);
  });

  it('flags a plugin the malformed-plugin scan diagnosed, and stops when the next scan does not', async () => {
    const facts = await over([[A], (made) => made.reconciled([held({ isCompiledPlugin: false })], { diagnoses: [diagnosis('first')] })]);
    const flagged = await flagsOf(facts);

    await facts.reconciled([held({ isCompiledPlugin: false })]);

    expect([flagged, await flagsOf(facts)]).toEqual([['nonCompiledPlugin', 'malformed'], ['nonCompiledPlugin']]);
  });

  it.each([
    ['a mod without a repository', 'SomeMod', 'SomeMod', [], ['inNonSourceMod']],
    ['a mod with a repository', 'SourceMod', 'SourceMod', ['SourceMod'], ['inSourceMod']],
    ['a mod named without case', 'sourcemod', 'SourceMod', ['SourceMod'], ['inSourceMod']],
    ['Overwrite', 'overwrite/', 'SomeMod', [], ['inOverwrite']],
    ['the game folder', 'Data/', 'SomeMod', [], []],
  ])('states where it lives: %s', async (_label, origin, mod, listedSourceMods, place) => {
    const facts = factsOver([{ name: 'A.esp', origin }], { value: { mods: [{ kind: 'mod', name: mod, enabled: true }], listedSourceMods: new Set(listedSourceMods) } });

    expect((await rowOf(facts, { name: 'A.esp', origin })).context.filter((word) => word.startsWith('in'))).toEqual(place);
  });

  it('states no place for an origin no mod folder carries', async () => {
    const facts = factsOver([{ name: 'A.esp', origin: 'Nowhere' }], { value: { mods: [] } });

    expect((await rowOf(facts, { name: 'A.esp', origin: 'Nowhere' })).context.filter((word) => word.startsWith('in'))).toEqual([]);
  });
});

describe('a name under two origins reads its own plugin', () => {
  const MOD_A = { name: 'Shared.esp', origin: 'ModA' };
  const MOD_B = { name: 'Shared.esp', origin: 'ModB' };
  const THIRD = { name: 'Shared.esp', origin: 'SomeOtherMod' };
  const sharedAt = (origin: string, overrides: Partial<PluginMetadata> = {}) => pluginMetadataFixture({ name: 'Shared.esp', origin, isCompiledPlugin: true, ...overrides });
  const bothHeld = (modB: Partial<PluginMetadata>, told = {}): Tell => (facts) => facts.reconciled([sharedAt('ModA'), sharedAt('ModB', modB)], told);
  const CLEAN = { description: undefined, icon: undefined, tooltip: ['Shared.esp', 'ModA'], editable: true, expansion: RECORDS };

  it.each<[string, readonly Shown[], Tell, Record<string, unknown>]>([
    ['sorting errors', [MOD_A, MOD_B], bothHeld({ masters: ['BMaster.esm'] }), {}],
    ['read-only', [MOD_A, MOD_B], bothHeld({ isImmutable: true }), {}],
    ['unreadable records', [MOD_A, MOD_B], bothHeld({ hasParseFailure: true }), {}],
    ['a diagnosis', [MOD_A, MOD_B], bothHeld({}, { diagnoses: [diagnosis('ModB is malformed', MOD_B)] }), {}],
    ['a failure to read', [MOD_A, MOD_B], (facts) => facts.reconciled([sharedAt('ModA')], { failures: [failure('Malformed record', MOD_B)] }), {}],
    ['a change outside Modbench', [MOD_A, MOD_B], bothHeld({}, { changedOutside: [MOD_B] }), {}],
    ['its own failure to read, the other plugin loaded', [MOD_A, MOD_B], (facts) => facts.reconciled([sharedAt('ModB')], { failures: [failure('Malformed record', MOD_A)] }),
      { description: 'failed to read', icon: 'error', tooltip: ['Shared.esp', 'ModA', 'Failed to read: Malformed record'], editable: false, expansion: errorOf('Malformed record') }],
    ['only the other plugin held', [MOD_A, MOD_B], (facts) => facts.reconciled([sharedAt('ModB')]), { editable: false, expansion: INDEXING }],
    ['read-only and a missing master, held under a third origin', [MOD_A, THIRD],
      (facts) => facts.reconciled([sharedAt('SomeOtherMod', { isImmutable: true, masters: ['Ghost.esm'] })]), { editable: false, expansion: INDEXING }],
    ['only the other plugin indexed', [MOD_A, MOD_B], (facts) => facts.indexed({ indexed: [MOD_B] }), { editable: false, expansion: INDEXING }],
    ['only the other plugin failed in a tick', [MOD_A, MOD_B], (facts) => facts.indexed({ failures: [failure('Malformed record', MOD_B)] }), { editable: false, expansion: INDEXING }],
  ])('is not touched by the other plugin\'s %s', async (_label, shown, tell, own) => {
    const facts = await over([shown, tell]);

    const { description, icon, tooltip, context } = await rowOf(facts, MOD_A);
    expect({ description, icon, tooltip, editable: context.includes('editable'), expansion: await facts.expansion('Shared.esp', 'ModA') }).toEqual({ ...CLEAN, ...own });
  });

  it.each([
    ['ModA', MOD_A, MOD_B, 'AGhost.esm'],
    ['ModB', MOD_B, MOD_A, 'BGhost.esm'],
  ])('judges the copy %s loads with its own masters, and the other copy not at all', async (_origin, active, inactive, ghost) => {
    const facts = factsOver([active, { ...inactive, enabled: false }]);

    await facts.reconciled([sharedAt('ModA', { masters: ['AGhost.esm'] }), sharedAt('ModB', { masters: ['BGhost.esm'] })]);

    expect((await rowOf(facts, active)).tooltip).toContain(`Error: "${ghost}" is a master of "Shared.esp", and is missing or not active.`);
    expect((await rowOf(facts, inactive)).description).toBeUndefined();
  });
});

describe('what a row expands into (plugins.md, States, stories 2-4 and 6)', () => {
  const heldAOnly: Tell = (facts) => facts.indexed({ indexed: [A] });
  const failedB: Tell = (facts) => facts.indexed({ indexed: [A], failures: [failure('Malformed record', B)] });

  it.each<[string, Tell, unknown, unknown]>([
    ['before any tick', () => Promise.resolve(), INDEXING, INDEXING],
    ['a tick holding A', heldAOnly, RECORDS, INDEXING],
    ['a tick holding nothing', (facts) => facts.indexed(), INDEXING, INDEXING],
    ['a tick that failed B', failedB, RECORDS, errorOf('Malformed record')],
    ['mEdit unreachable', then(heldAOnly, (facts) => facts.unreachable()), RECORDS, errorOf('mEdit is disconnected.')],
    ['another window holds the record index', then(heldAOnly, (facts) => facts.refused(HELD_ELSEWHERE)), errorOf(HELD_ELSEWHERE.message), errorOf(HELD_ELSEWHERE.message)],
    ['the snapshot failed', then(heldAOnly, (facts) => facts.refused(FAILED_INDEX)), RECORDS, errorOf(FAILED_INDEX.message)],
    ['a failure of B over mEdit unreachable', then(failedB, (facts) => facts.unreachable()), RECORDS, errorOf('Malformed record')],
    ['the other window over mEdit unreachable', then((facts) => facts.refused(HELD_ELSEWHERE), (facts) => facts.unreachable()),
      errorOf(HELD_ELSEWHERE.message), errorOf(HELD_ELSEWHERE.message)],
    ['mEdit unreachable, then another window', then((facts) => facts.unreachable(), (facts) => facts.refused(HELD_ELSEWHERE)),
      errorOf(HELD_ELSEWHERE.message), errorOf(HELD_ELSEWHERE.message)],
    ['a tick after a refusal', then((facts) => facts.refused(HELD_ELSEWHERE), heldAOnly), RECORDS, INDEXING],
    ['a tick after mEdit was unreachable', then((facts) => facts.unreachable(), heldAOnly), RECORDS, INDEXING],
    ['the hand-off after a refusal', then((facts) => facts.refused(FAILED_INDEX), (facts) => facts.reconciled([held()])), RECORDS, INDEXING],
  ])('%s', async (_label, tell, forA, forB) => {
    const facts = await over([[A, B], tell]);

    expect([await facts.expansion('A.esp'), await facts.expansion('B.esp')]).toEqual([forA, forB]);
  });

  it('a tick that names no failure replaces the last tick\'s failures', async () => {
    const facts = factsOver([A, B]);
    await facts.indexed({ failures: [failure('Malformed record', B)] });

    await facts.indexed();

    expect(await facts.expansion('B.esp')).toEqual(INDEXING);
  });
});

describe('the record index failure message (plugins.md, States, story 6)', () => {
  const failedThen = (step: Tell): Tell => then((facts) => facts.refused(FAILED_INDEX), step);

  it.each<[string, Tell, string | undefined]>([
    ['nothing holds', () => Promise.resolve(), undefined],
    ['the snapshot failed', (facts) => facts.refused(FAILED_INDEX), 'Indexing failed: the record index threw'],
    ['another window holds the record index', (facts) => facts.refused(HELD_ELSEWHERE), undefined],
    ['another window after the failure', failedThen((facts) => facts.refused(HELD_ELSEWHERE)), undefined],
    ['a tick after the failure', failedThen((facts) => facts.indexed({ indexed: [A] })), undefined],
    ['the hand-off after the failure', failedThen((facts) => facts.reconciled([held()])), undefined],
  ])('%s', async (_label, tell, message) => {
    const facts = await over([[A], tell]);

    expect(facts.message()).toBe(message);
  });
});

describe('another window holds the record index (ADR-0010)', () => {
  it.each<[string, Tell, string[]]>([
    ['nothing holds', () => Promise.resolve(), []],
    ['another window holds it', (facts) => facts.refused(HELD_ELSEWHERE), ['another window holds this instance']],
    ['the snapshot failed, which is not the other window', (facts) => facts.refused(FAILED_INDEX), ['Indexing failed: the record index threw']],
    ['a tick after', then((facts) => facts.refused(HELD_ELSEWHERE), (facts) => facts.indexed({ indexed: [A] })), []],
  ])('%s', async (_label, tell, lines) => {
    const facts = await over([[A], tell]);

    expect(facts.plugins.standing.plugins()).toEqual(lines);
  });
});

describe('a read that failed (common.md, States, stories 2 and 6)', () => {
  const failing = held({ laterReadFailure: [{ sourceRelativePath: 'A.esp/Npc.json', message: 'Unexpected end at 12.' }, { sourceRelativePath: 'A.esp/Cell.json', message: 'Duplicate FormKey.' }] });
  const laterFailing = (name: string) => held({ name, laterReadFailure: [{ sourceRelativePath: `${name}/X.json`, message: 'bad' }] });
  const REFUSED = { failed: 'refused', refusal: '503' } as const;
  const SAID = '503';

  it('says every failure, naming the plugin and each file and message', async () => {
    const facts = factsOver([A, B]);

    await facts.reconciled([failing, laterFailing('B.esp')]);

    expect(facts.message()).toBe(
      'Showing the last good read: "A.esp" (SomeMod): A.esp/Npc.json: Unexpected end at 12; A.esp/Cell.json: Duplicate FormKey; "B.esp" (SomeMod): B.esp/X.json: bad',
    );
  });

  it('drops the later read failure of a named plugin mEdit\'s answer leaves out, and keeps the others\'', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([laterFailing('A.esp'), laterFailing('B.esp')]);

    await facts.changed([], [A]);

    expect(facts.message()).toBe('Showing the last good read: "B.esp" (SomeMod): B.esp/X.json: bad');
  });

  it('keeps the order of the later read failures through an answer for a named plugin', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([laterFailing('A.esp'), laterFailing('B.esp')]);

    await facts.changed([held({ laterReadFailure: [{ sourceRelativePath: 'A.esp/Y.json', message: 'worse' }] })], [A]);

    expect(facts.message()).toBe('Showing the last good read: "A.esp" (SomeMod): A.esp/Y.json: worse; "B.esp" (SomeMod): B.esp/X.json: bad');
  });

  describe.each<[string, Tell, Tell]>([
    ['the malformed-plugin scan', (facts) => facts.reconciled([held()], { diagnoses: REFUSED }), (facts) => facts.reconciled([held()])],
    ["mEdit's facts about each plugin", (facts) => facts.changed(REFUSED), (facts) => facts.changed([held()])],
  ])('%s', (read, fail, answer) => {
    it('says it failed to load when it failed before any answered', async () => {
      const facts = factsOver([A]);
      await facts.indexed({ indexed: [A] });

      await fail(facts);

      expect(facts.message()).toBe(`Failed to load: ${read}: ${SAID}`);
    });

    it('says the last good read shows when it failed after one answered', async () => {
      const facts = factsOver([A]);
      await facts.reconciled([held()]);

      await fail(facts);

      expect(facts.message()).toBe(`Showing the last good read: ${read}: ${SAID}`);
    });

    it('says nothing once the next read answers', async () => {
      const facts = factsOver([A]);
      await facts.indexed({ indexed: [A] });
      await fail(facts);

      await answer(facts);

      expect(facts.message()).toBeUndefined();
    });
  });

  it('says the last good read and a read that never answered as two statements', async () => {
    const facts = factsOver([A, B]);

    await facts.reconciled([laterFailing('B.esp')], { diagnoses: REFUSED });

    expect(facts.message()).toBe(`Showing the last good read: "B.esp" (SomeMod): B.esp/X.json: bad. Failed to load: the malformed-plugin scan: ${SAID}`);
  });

  it('puts the instance read failure and every failed read under one prefix', async () => {
    const facts = factsOver([A]);
    await facts.reconciled([failing]);
    await facts.reconciled([failing], { diagnoses: REFUSED });

    facts.instance.fail('mo2 gone');

    await settled(() => {
      expect(facts.message()).toBe(
        `Showing the last good read: mo2 gone; "A.esp" (SomeMod): A.esp/Npc.json: Unexpected end at 12; A.esp/Cell.json: Duplicate FormKey; the malformed-plugin scan: ${SAID}`,
      );
    });
  });

  it('names an unreadable plugin list on the rows and the message line', async () => {
    const facts = factsOver([A]);

    await facts.reconciled({ failed: 'unreachable' });

    expect([await facts.expansion('A.esp'), facts.message()]).toEqual([
      errorOf('mEdit could not be reached.'), "Failed to load: mEdit's facts about each plugin: mEdit could not be reached.",
    ]);
  });

  const truncated = failure('Could not read this plugin (truncated).');
  const ROWS_GONE = 'The records of "A.esp" (SomeMod) do not show: its read failed.';
  it.each([
    ['names a plugin whose rows stood until a failed read took them', [held({ rowsFrom: 'Binary' })], [held({ rowsFrom: null })], [ROWS_GONE]],
    ['names a plugin whose failed read leaves mEdit no answer for it', [held({ rowsFrom: 'Binary' })], [], [ROWS_GONE]],
    ['names none while its rows stand', [held({ rowsFrom: 'Binary' })], [held({ rowsFrom: 'Binary' })], []],
    ['names none whose rows never stood', [held({ rowsFrom: null })], [held({ rowsFrom: null })], []],
  ] as const)('the reconcile that lands a failed read %s', async (_label, before, after, gone) => {
    const facts = factsOver([A]);
    await facts.reconciled([...before]);

    await facts.reconciled([...after], { failures: [truncated] });

    expect(facts.reporter('loadOrder').reports.map(({ message }) => message)).toEqual(gone);
  });

  it('names a plugin whose rows a failed read took once, however often the next reconciles hear it', async () => {
    const facts = factsOver([A]);
    await facts.reconciled([held({ rowsFrom: 'Binary' })]);
    await facts.reconciled([held({ rowsFrom: null })], { failures: [truncated] });

    await facts.reconciled([held({ rowsFrom: null })], { failures: [truncated] });

    expect(facts.reporter('loadOrder').reports.map(({ message }) => message)).toEqual([ROWS_GONE]);
  });

  const reconciledFailing = (rowsFrom: PluginMetadata['rowsFrom']): Tell => (facts) => facts.reconciled([held({ rowsFrom })], { failures: [truncated] });
  const tickedFailing = (rowsFrom: PluginMetadata['rowsFrom']): Tell => then(
    (facts) => facts.indexed({ indexed: [A] }), (facts) => facts.changed([held({ rowsFrom })]), (facts) => facts.indexed({ failures: [truncated] }),
  );
  it.each<[string, Tell, string | undefined, unknown]>([
    ['while its rows stand, says it shows the last good read and expands into them', reconciledFailing('Binary'),
      'Showing the last good read: "A.esp" (SomeMod): Could not read this plugin (truncated).', RECORDS],
    ['with no rows left, says no last good read and expands into the error row', reconciledFailing(null), undefined, errorOf('Could not read this plugin (truncated).')],
    ['while its rows stand through a reconcile\'s tick, says it shows the last good read and expands into them', tickedFailing('Binary'),
      'Showing the last good read: "A.esp" (SomeMod): Could not read this plugin (truncated).', RECORDS],
    ['with no rows left through a reconcile\'s tick, says no last good read and expands into the error row', tickedFailing(null),
      undefined, errorOf('Could not read this plugin (truncated).')],
  ])('a plugin whose read failed, %s', async (_label, tell, message, expansion) => {
    const facts = await over([[A], tell]);

    expect([facts.message(), await facts.expansion('A.esp')]).toEqual([message, expansion]);
  });

  it.each([[null], [undefined]])('says nothing once the next read answers %s', async (answer) => {
    const facts = factsOver([A]);
    await facts.reconciled([failing]);

    await facts.changed([held({ laterReadFailure: answer })]);

    expect(facts.message()).toBeUndefined();
  });
});

describe('what a row shows of its plugin, as data for the agent (agent.md, Any agent, story 8)', () => {
  it('is each status\'s words and tooltip line, whether it is read-only, whether it is a compiled plugin, and its masters', async () => {
    const facts = factsOver([A]);

    await facts.reconciled([held({ isImmutable: true, masters: ['Ghost.esm'] })], { failures: [failure('Malformed record')], changedOutside: [A] });

    expect(facts.agent.shown(A)).toEqual({
      statuses: [
        { status: 'failed to read', tooltip: 'Failed to read: Malformed record' },
        { status: '1 error', tooltip: `Error: ${missingMaster('Ghost.esm')}` },
        { status: 'changed outside Modbench', tooltip: CHANGED_TEXT },
      ],
      readOnly: true, compiled: true, masters: ['Ghost.esm'],
    });
  });

  it('is no status, and null for what mEdit has not read', () => {
    expect(factsOver([A]).agent.shown(A)).toEqual({ statuses: [], readOnly: null, compiled: null, masters: null });
  });
});

describe('the suggested move of a broken sorting rule (plugins.md, Sorting rules, story 5)', () => {
  const flagged = async (facts: Facts, address: typeof A) => (await rowOf(facts, address)).context.includes('suggestedMove');

  it('offers the plugin that moves, and flags only its row', async () => {
    const facts = await over(masterFlagAfterB());

    expect(facts.agent.suggestedMoves().map(({ mover, drop }) => ({ mover, drop }))).toEqual([
      { mover: { origin: 'SomeMod', name: 'A.esp' }, drop: { kind: 'before', name: 'B.esp' } },
    ]);
    expect([await flagged(facts, A), await flagged(facts, B)]).toEqual([true, false]);
  });

  it('offers no move of a plugin the game loads with no line', async () => {
    const facts = factsOver([B, { ...A, noLine: true }]);

    await facts.reconciled([held({ isMaster: true }), held(B)]);

    expect(facts.agent.suggestedMoves()).toEqual([]);
  });

  it('offers no move the last judging did not find', async () => {
    const facts = await over(masterFlagAfterB());

    await facts.reconciled([held({ isMaster: false }), held(B)]);

    expect(facts.agent.suggestedMoves()).toEqual([]);
  });
});

describe('an answer for named plugins changes only theirs (ADR-0029, Consequences, bullet 5)', () => {
  it('drops the unreadable source of a named plugin mEdit\'s answer leaves out, and keeps the others\'', async () => {
    const sourceGone = (name: string) => held({ name, pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: false } });
    const facts = factsOver([A, B]);
    await facts.reconciled([sourceGone('A.esp'), sourceGone('B.esp')]);

    await facts.changed([], [A]);

    expect(host.problems('modbench-source-unreadable').map(([path]) => path)).toEqual(['/mods/SomeMod/B.esp']);
  });

  it('takes the masters of a named plugin and keeps the others\'', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([held({ masters: ['X.esm'] }), held({ name: 'B.esp', masters: ['Y.esm'] })]);

    await facts.changed([held({ masters: ['Z.esm'] })], [A]);

    expect([facts.agent.shown(A).masters, facts.agent.shown(B).masters]).toEqual([['Z.esm'], ['Y.esm']]);
  });

  it('judges a rule\'s condition on an inactive named plugin by its new answer', async () => {
    const C = { name: 'C.esp', origin: 'SomeMod' };
    const facts = factsOver([A, B, { ...C, enabled: false }], { masterlist: "plugins:\n  - name: 'A.esp'\n    after: [{name: B.esp, condition: 'is_master(\"C.esp\")'}]\n" });
    await facts.reconciled([held(), held(B), held(C)]);
    const brokenBefore = facts.agent.brokenRules().map(({ level }) => level);

    await facts.changed([held({ ...C, isMaster: true })], [C]);

    expect([brokenBefore, facts.agent.brokenRules().map(({ level }) => level)]).toEqual([[], ['warning']]);
  });
});

describe('the record filter hides a plugin with no record it matches (plugins.md, Order and view state, story 4)', () => {
  const SQL = 'SELECT form_key FROM "armo"';
  const P = (at: number) => ({ name: `P${at}.esp`, origin: 'SomeMod' });
  const shownOf = (facts: Facts, plugins: readonly typeof A[]) => Promise.all(plugins.map(async ({ name }) => (await facts.row(name)) !== undefined));

  async function filtered(facts: Facts) {
    host.files.set('armor.sql', SQL);
    facts.client.setQueryAnswer('setFilter', null);
    facts.client.setQueryAnswer('getActiveFilter', { sql: SQL, source: 'armor.sql' });
    await host.run('modbench.record.filter', Uri.file('/workspace/armor.sql'));
    await settle();
  }

  async function matching(matches: readonly boolean[]) {
    const plugins = matches.map((_, at) => P(at));
    const facts = factsOver(plugins);
    await facts.reconciled(matches.map((hasMatchingRecords, at) => held({ ...P(at), hasMatchingRecords })));
    await filtered(facts);
    return { facts, plugins };
  }

  it.each([
    ['one with matches among others without', [true, false], [true, false], undefined],
    ['every plugin without', [false, false], [false, false], 'No records match armor.sql.'],
  ])('hides from the rows %s', async (_label, matches, shown, message) => {
    const { facts, plugins } = await matching(matches);

    expect([await shownOf(facts, plugins), facts.message()]).toEqual([shown, message]);
  });

  it('forgets that no plugin matched once the record filter changes', async () => {
    const { facts, plugins } = await matching([false]);
    const answer = deferred<PluginMetadata[]>();
    facts.client.setQueryAnswerOnce('getPlugins', answer.promise);
    host.files.set('weapons.sql', SQL);
    facts.client.setQueryAnswer('getActiveFilter', { sql: SQL, source: 'weapons.sql' });

    await host.run('modbench.record.filter', Uri.file('/workspace/weapons.sql'));
    await settle();

    expect([await shownOf(facts, plugins), facts.message()]).toEqual([[true], undefined]);
  });

  it('hides a plugin by its own answer, not by the answer for another plugin of its name', async () => {
    const shared = (origin: string) => ({ name: 'Shared.esp', origin });
    const facts = factsOver([shared('ModA'), shared('ModB')]);
    await facts.reconciled([held({ ...shared('ModA'), hasMatchingRecords: true }), held({ ...shared('ModB'), hasMatchingRecords: false })]);

    await filtered(facts);

    expect([(await facts.row('Shared.esp', 'ModA')) !== undefined, (await facts.row('Shared.esp', 'ModB')) !== undefined]).toEqual([true, false]);
  });

  it('keeps a plugin hidden through a tick that indexes nothing yet', async () => {
    const { facts, plugins } = await matching([false]);

    await facts.indexed();

    expect(await shownOf(facts, plugins)).toEqual([false]);
  });

  it('hides nothing and matches something while mEdit has not said', async () => {
    const facts = factsOver([A]);

    await filtered(facts);

    expect([await shownOf(facts, [A]), facts.message()]).toEqual([[true], undefined]);
  });

  it('says no record matches once the last plugin with matches has none', async () => {
    const { facts } = await matching([true, false]);

    await facts.changed([held({ ...P(0), hasMatchingRecords: false })], [P(0)]);

    expect(facts.message()).toBe('No records match armor.sql.');
  });
});
