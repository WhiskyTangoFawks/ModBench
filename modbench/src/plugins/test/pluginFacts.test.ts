import { describe, it, expect } from 'vitest';
import { modOfOriginIn } from '../../test/mo2/instanceValueFixture';
import type { PluginDiagnosisReport, PluginLoadFailure, PluginMetadata } from '../../client';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { PluginFacts, placeOf, type PluginPlace } from '../pluginFacts';

const A = { name: 'A.esp', origin: 'SomeMod' };

const held = (overrides: Partial<PluginMetadata> = {}): PluginMetadata => pluginMetadataFixture({ name: 'A.esp', isCompiledPlugin: true, ...overrides });
const failure = (reason: string, address = A): PluginLoadFailure => ({ ...address, reason });
const diagnosis = (text: string, address = A): PluginDiagnosisReport => (
  { plugin: address.name, origin: address.origin, text }
);
const changedOutside = (facts: PluginFacts, origin: string, ...names: string[]): void => facts.externalChange({
  origin, changedPlugins: names.map((name) => ({ name, bytesSha256: 'ab12' })),
});

const CHANGED_TEXT = 'Changed outside Modbench: its bytes differ from what Modbench last wrote.';

type Scene = (facts: PluginFacts) => void;

const reconciledWith = (overrides: Partial<PluginMetadata>): Scene => (facts) => facts.reconciled([held(overrides)], []);
const failed: Scene = (facts) => facts.reconciled([], [failure('Malformed record')]);
const masters = (...missing: string[]): Scene => (facts) => facts.reconciled([held({ missingMasters: missing })], []);
const unreadable: Scene = (facts) => facts.reconciled([held({ hasParseFailure: true })], []);
const sourceUnreadable: Scene = (facts) => facts.reconciled([held({ isCompiledPlugin: true, pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } })], []);
const sourceUnreadableForGood: Scene = (facts) => facts.reconciled([held({ isCompiledPlugin: true, pluginSourceUnreadable: { reason: 'Twin folders.', decompileRepairs: false } })], []);
const changed: Scene = (facts) => changedOutside(facts, 'SomeMod', 'A.esp');
const malformed: Scene = (facts) => facts.diagnosed([diagnosis('first'), diagnosis('second')]);
const scenes = (...parts: Scene[]): Scene => (facts) => parts.forEach((part) => part(facts));

describe('PluginFacts — the tooltip names the origin (plugins.md, A row, Plugin, Tooltip)', () => {
  it('names the game folder as the user reads it', () => {
    expect(new PluginFacts().tooltipLines({ name: 'A.esp', origin: 'Data/' })).toEqual(['A.esp', 'the game folder']);
  });
});

describe('PluginFacts — the status table (plugins.md, A row, Plugin)', () => {
  it.each([
    ['nothing', scenes(), undefined, undefined, []],
    ['failed to read', failed, 'error', 'failed to read', ['Failed to read: Malformed record']],
    ['one master issue', masters('Ghost.esm'), 'error', '1 master issue', ['Missing masters: Ghost.esm']],
    ['two master issues', masters('Ghost.esm', 'Off.esm'), 'error', '2 master issues', ['Missing masters: Ghost.esm, Off.esm']],
    ['no master issues', masters(), undefined, undefined, []],
    ['unreadable records', unreadable, 'error', 'unreadable records',
      ['This plugin holds a record that could not be read into its document.']],
    ['plugin source unreadable', sourceUnreadable, 'warning', 'plugin source unreadable',
      ['read-only', 'Plugin source unreadable: Its folder is gone. Its records are those of its plugin file, until decompile writes its source.']],
    ['plugin source unreadable that decompile does not repair', sourceUnreadableForGood, 'warning', 'plugin source unreadable',
      ['read-only', 'Plugin source unreadable: Twin folders. Its records are those of its plugin file.']],
    ['changed outside Modbench', changed, 'warning', 'changed outside Modbench', [CHANGED_TEXT]],
    ['malformed', malformed, 'warning', 'malformed', ['Malformed: first; second']],
  ] as const)('%s', (_label, scene, icon, words, tooltipLines) => {
    const facts = new PluginFacts();
    scene(facts);

    expect(facts.icon(A)).toBe(icon);
    expect(facts.description(A)).toBe(words);
    expect(facts.tooltipLines(A)).toEqual(['A.esp', 'SomeMod', ...tooltipLines]);
  });

  it.each([
    ['failed to read, then master issues', scenes(failed, masters('Ghost.esm')), 'error'],
    ['master issues, then unreadable records', scenes(masters('Ghost.esm'), unreadable), 'error'],
    ['unreadable records over plugin source unreadable', scenes(sourceUnreadable, unreadable), 'error'],
    ['plugin source unreadable over changed outside', scenes(changed, sourceUnreadable), 'warning'],
    ['unreadable records, then changed outside', scenes(unreadable, changed), 'error'],
    ['changed outside, then malformed', scenes(changed, malformed), 'warning'],
    ['master issues over changed outside', scenes(masters('Ghost.esm'), changed), 'error'],
    ['unreadable records over malformed', scenes(unreadable, malformed), 'error'],
    ['failed to read over malformed', scenes(malformed, failed), 'error'],
    ['malformed alone', malformed, 'warning'],
  ] as const)('%s: the first status that holds sets the icon', (_label, scene, icon) => {
    const facts = new PluginFacts();
    scene(facts);

    expect(facts.icon(A)).toBe(icon);
  });

  it('lists every status in the spec order whatever the order they landed in', () => {
    const facts = new PluginFacts();
    scenes(malformed, changed)(facts);
    facts.reconciled([held({ hasParseFailure: true, pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true }, missingMasters: ['Ghost.esm'] })], [failure('Malformed record')]);

    expect(facts.description(A)).toBe('failed to read, 1 master issue, unreadable records, plugin source unreadable, changed outside Modbench, malformed');
  });

  it.each([
    ['a master that loads after the plugin and an inactive one', { missingMasters: ['Ghost.esm'], lateMasters: ['Late.esm'] }, '2 master issues', 'Missing masters: Ghost.esm; Masters loading after it: Late.esm'],
    ['a lone late master', { lateMasters: ['Late.esm'] }, '1 master issue', 'Masters loading after it: Late.esm'],
  ])('counts and names %s', (_label, facts, words, line) => {
    const plugins = new PluginFacts();
    plugins.reconciled([held(facts)], []);

    expect(plugins.description(A)).toBe(words);
    expect(plugins.tooltipLines(A)).toContain(line);
  });

  it('keeps the last late masters while mEdit has not checked', () => {
    const facts = new PluginFacts();
    facts.reconciled([held({ lateMasters: ['Late.esm'] })], []);

    facts.refreshed([held({ missingMasters: null, lateMasters: null })]);

    expect(facts.description(A)).toBe('1 master issue');
  });

  it('carries the read-only line between the origin and the status lines', () => {
    const facts = new PluginFacts();
    facts.reconciled([held({ isImmutable: true, missingMasters: ['Ghost.esm'] })], []);

    expect(facts.tooltipLines(A)).toEqual(['A.esp', 'SomeMod', 'read-only', 'Missing masters: Ghost.esm']);
  });

  it.each([
    ['a plugin named in no answer', { name: 'B.esp', origin: 'SomeMod' }],
    ['the same plugin file name of another origin', { name: 'A.esp', origin: 'OtherMod' }],
  ])('shows nothing on %s', (_label, address) => {
    const facts = new PluginFacts();
    scenes(failed, masters('Ghost.esm'), unreadable, changed, malformed)(facts);

    expect(facts.description(address)).toBeUndefined();
  });
});

describe('PluginFacts — plugins that differ only in case', () => {
  it('shows each its own reason for failing to read', () => {
    const facts = new PluginFacts();
    const upper = { name: 'Foo.esp', origin: 'SomeMod' };
    const lower = { name: 'foo.esp', origin: 'SomeMod' };
    facts.reconciled([], [failure('differs from foo.esp', upper), failure('differs from Foo.esp', lower)]);

    expect(facts.tooltipLines(upper)).toContain('Failed to read: differs from foo.esp');
    expect(facts.tooltipLines(lower)).toContain('Failed to read: differs from Foo.esp');
    expect(facts.expansion(upper)).toEqual({ kind: 'error', message: 'differs from foo.esp' });
    expect(facts.expansion(lower)).toEqual({ kind: 'error', message: 'differs from Foo.esp' });
  });
});

describe('PluginFacts — which statuses stay and which land (plugins.md, A row, bullets)', () => {
  it('shows no master status while mEdit has not checked, which is not no issues', () => {
    const facts = new PluginFacts();
    facts.reconciled([held({ missingMasters: null })], []);

    expect(facts.description(A)).toBeUndefined();
  });

  it.each([
    ['unchecked', null, 'Missing masters: Ghost.esm'],
    ['checked and clean', [], undefined],
    ['checked and changed', ['Other.esm'], 'Missing masters: Other.esm'],
  ])('keeps the last master issues until a snapshot is indexed: a re-read that is %s', (_label, next, line) => {
    const facts = new PluginFacts();
    facts.reconciled([held({ missingMasters: ['Ghost.esm'] })], []);

    facts.refreshed([held({ missingMasters: next })]);

    expect(facts.tooltipLines(A).slice(2)).toEqual(line === undefined ? [] : [line]);
  });

  it('keeps the last master issues through a tick that indexes the plugin', () => {
    const facts = new PluginFacts();
    facts.reconciled([held({ missingMasters: ['Ghost.esm'] })], []);

    facts.indexed([A], []);

    expect(facts.tooltipLines(A)).toContain('Missing masters: Ghost.esm');
  });

  it('forgets the last master issues of a plugin a re-read omits', () => {
    const facts = new PluginFacts();
    facts.reconciled([held({ missingMasters: ['Ghost.esm'] })], []);

    facts.refreshed([]);
    facts.refreshed([held({ missingMasters: null })]);

    expect(facts.description(A)).toBeUndefined();
  });

  it('keeps a failed plugin failed through a tick that does not name it, until a reconcile lands', () => {
    const facts = new PluginFacts();
    facts.reconciled([], [failure('Malformed record')]);

    facts.indexed([], []);
    expect(facts.description(A)).toBe('failed to read');

    facts.reconciled([held()], []);
    expect(facts.description(A)).toBeUndefined();
  });

  it('adds each tick\'s failures to the last, for the row, and replaces them for the expansion', () => {
    const facts = new PluginFacts();
    facts.indexed([], [failure('first')]);
    facts.indexed([], [failure('second', B)]);

    expect(facts.description(A)).toBe('failed to read');
    expect(facts.description(B)).toBe('failed to read');
    expect(facts.expansion(A)).toEqual({ kind: 'indexing' });
    expect(facts.expansion(B)).toEqual({ kind: 'error', message: 'second' });
  });

  it('expands a plugin failed in the last reconcile to its reason, and one that failed only before it to nothing', () => {
    const facts = new PluginFacts();
    facts.indexed([], [failure('first')]);
    facts.reconciled([], []);

    expect(facts.expansion(A)).toEqual({ kind: 'indexing' });

    facts.reconciled([], [failure('second')]);
    expect(facts.expansion(A)).toEqual({ kind: 'error', message: 'second' });
  });

  it('keeps the last diagnoses until the next scan lands, and a scan that finds nothing clears them', () => {
    const facts = new PluginFacts();
    facts.diagnosed([diagnosis('some')]);
    facts.reconciled([held()], []);
    expect(facts.description(A)).toBe('malformed');

    facts.diagnosed([]);
    expect(facts.description(A)).toBeUndefined();
  });

  it('replaces what a mod\'s last settle named with its next, and leaves other mods\' alone', () => {
    const facts = new PluginFacts();
    const C = { name: 'C.esp', origin: 'OtherMod' };
    changedOutside(facts, 'SomeMod', 'A.esp');
    changedOutside(facts, 'OtherMod', 'C.esp');
    changedOutside(facts, 'SomeMod');

    expect(facts.description(A)).toBeUndefined();
    expect(facts.description(C)).toBe('changed outside Modbench');
  });
});

describe('PluginFacts — the Problems panel reads the answers the rows read', () => {
  it('lists the scan\'s reports as they were answered', () => {
    const facts = new PluginFacts();
    const B = { name: 'B.esp', origin: 'SomeMod' };
    facts.diagnosed([diagnosis('first'), diagnosis('second', B)]);

    expect(facts.problems().malformed).toEqual([diagnosis('first'), diagnosis('second', B)]);
  });

  it('lists a warning for every plugin changed outside, each mod\'s settle replacing its own', () => {
    const facts = new PluginFacts();
    changedOutside(facts, 'SomeMod', 'A.esp');
    changedOutside(facts, 'OtherMod', 'C.esp');
    expect(facts.problems().changedOutside).toEqual([
      { plugin: 'A.esp', origin: 'SomeMod', text: CHANGED_TEXT },
      { plugin: 'C.esp', origin: 'OtherMod', text: CHANGED_TEXT },
    ]);

    changedOutside(facts, 'SomeMod');
    expect(facts.problems().changedOutside).toEqual([{ plugin: 'C.esp', origin: 'OtherMod', text: CHANGED_TEXT }]);
  });

  it('lists the diagnosis of each failed read that carries one, on its plugin, as the reconcile answered', () => {
    const facts = new PluginFacts();
    const B = { name: 'B.esp', origin: 'SomeMod' };
    facts.reconciled([], [{ ...failure('Could not read (duplicate FormKey).'), diagnosis: 'duplicate FormKey' }, failure('Malformed record', B)]);

    expect(facts.problems().failedToRead).toEqual([{ plugin: 'A.esp', origin: 'SomeMod', text: 'duplicate FormKey' }]);

    facts.reconciled([], []);
    expect(facts.problems().failedToRead).toEqual([]);
  });
});

describe('PluginFacts — what a row states about its plugin', () => {
  it.each([
    ['nothing before mEdit answers', scenes(), [], { editable: false }],
    ['a plugin with no source', reconciledWith({ isCompiledPlugin: false }), ['nonCompiledPlugin'], { editable: false }],
    ['an editable compiled plugin', reconciledWith({ isCompiledPlugin: true }), ['compiledPlugin', 'editable'], { editable: true }],
    ['a read-only compiled plugin', reconciledWith({ isCompiledPlugin: true, isImmutable: true }), ['compiledPlugin'], { editable: false }],
    ['a compiled plugin whose plugin source is unreadable', sourceUnreadable, ['compiledPlugin'], { editable: false }],
  ] as const)('%s', (_label, scene, flags, conditions) => {
    const facts = new PluginFacts();
    scene(facts);

    expect(facts.contextFlags(A)).toEqual(flags);
    expect(facts.conditions(A)).toEqual(conditions);
  });

  it('flags a plugin the malformed-plugin scan diagnosed, and stops when the next scan does not', () => {
    const facts = new PluginFacts();
    malformed(facts);
    const flagged = facts.contextFlags(A);
    facts.diagnosed([]);

    expect(flagged).toEqual(['malformed']);
    expect(facts.contextFlags(A)).toEqual([]);
  });

});

describe('PluginFacts — which plugins mEdit holds and the record filter', () => {
  it('holds the plugins of the last tick or reconcile, by origin', () => {
    const facts = new PluginFacts();
    facts.indexed([A], []);

    expect(facts.expansion(A)).toEqual(RECORDS);
    expect(facts.expansion({ name: 'A.esp', origin: 'OtherMod' })).toEqual(INDEXING);

    facts.indexed([], []);
    expect(facts.expansion(A)).toEqual(INDEXING);
  });

  it.each([
    ['one with matches among others without', [true, false], [false, true], false],
    ['every plugin without', [false, false], [true, true], true],
    ['no plugin at all', [], [], false],
  ])('%s', (_label, answers, hidden, matchesNothing) => {
    const facts = new PluginFacts();
    facts.refreshed(answers.map((hasMatchingRecords, i) => held({ name: `P${i}.esp`, hasMatchingRecords })));

    expect(answers.map((_, i) => facts.hiddenByRecordFilter({ name: `P${i}.esp`, origin: 'SomeMod' }))).toEqual(hidden);
    expect(facts.noRecordMatchMessage('weapon')).toBe(matchesNothing ? 'No records match weapon.' : undefined);
  });

  it('keeps a plugin hidden through a tick that indexes nothing yet', () => {
    const facts = new PluginFacts();
    facts.refreshed([held({ hasMatchingRecords: false })]);

    facts.indexed([], []);

    expect(facts.hiddenByRecordFilter(A)).toBe(true);
  });

  it('forgets that no plugin matched once the record filter changes', () => {
    const facts = new PluginFacts();
    facts.refreshed([held({ hasMatchingRecords: false })]);

    facts.forgetMatches();

    expect(facts.noRecordMatchMessage('weapon')).toBeUndefined();
  });

  it('hides nothing and matches something while mEdit has not said', () => {
    const facts = new PluginFacts();

    expect(facts.hiddenByRecordFilter(A)).toBe(false);
    expect(facts.noRecordMatchMessage('weapon')).toBeUndefined();
  });
});

const heldElsewhere = { kind: 'heldElsewhere', message: 'another window holds this instance' } as const;
const failedIndex = { kind: 'failed', message: 'the record index threw' } as const;
const B = { name: 'B.esp', origin: 'SomeMod' };
const RECORDS = { kind: 'records' } as const;
const INDEXING = { kind: 'indexing' } as const;
const errorOf = (message: string) => ({ kind: 'error', message }) as const;

const heldAOnly: Scene = (facts) => facts.indexed([A], []);

describe('PluginFacts — what a row expands into (plugins.md, States, stories 2-4 and 6)', () => {
  it.each([
    ['before any tick', scenes(), INDEXING, INDEXING],
    ['a tick holding A', heldAOnly, RECORDS, INDEXING],
    ['a tick holding nothing', (facts: PluginFacts) => facts.indexed([], []), INDEXING, INDEXING],
    ['a tick that failed B', (facts: PluginFacts) => facts.indexed([A], [failure('Malformed record', B)]),
      RECORDS, errorOf('Malformed record')],
    ['mEdit unreachable', scenes(heldAOnly, (facts) => facts.unreachable('mEdit is down')), RECORDS, errorOf('mEdit is down')],
    ['another window holds the record index', scenes(heldAOnly, (facts) => facts.refused(heldElsewhere)),
      errorOf(heldElsewhere.message), errorOf(heldElsewhere.message)],
    ['the snapshot failed', scenes(heldAOnly, (facts) => facts.refused(failedIndex)), RECORDS, errorOf(failedIndex.message)],
    ['a failure of B over mEdit unreachable',
      scenes((facts) => facts.indexed([A], [failure('Malformed record', B)]), (facts) => facts.unreachable('mEdit is down')),
      RECORDS, errorOf('Malformed record')],
    ['the other window over mEdit unreachable',
      scenes((facts) => facts.refused(heldElsewhere), (facts) => facts.unreachable('mEdit is down')),
      errorOf(heldElsewhere.message), errorOf(heldElsewhere.message)],
    ['mEdit unreachable, then another window', scenes((facts) => facts.unreachable('mEdit is down'), (facts) => facts.refused(heldElsewhere)),
      errorOf(heldElsewhere.message), errorOf(heldElsewhere.message)],
    ['a tick after a refusal', scenes((facts) => facts.refused(heldElsewhere), heldAOnly), RECORDS, INDEXING],
    ['a tick after mEdit was unreachable', scenes((facts) => facts.unreachable('mEdit is down'), heldAOnly), RECORDS, INDEXING],
    ['the hand-off after a refusal', scenes((facts) => facts.refused(failedIndex), (facts) => facts.reconciled([held()], [])),
      RECORDS, INDEXING],
  ] as const)('%s', (_label, scene, forA, forB) => {
    const facts = new PluginFacts();
    scene(facts);

    expect(facts.expansion(A)).toEqual(forA);
    expect(facts.expansion(B)).toEqual(forB);
  });

  it('a tick that names no failure replaces the last tick\'s failures', () => {
    const facts = new PluginFacts();
    facts.indexed([], [failure('Malformed record', B)]);
    facts.indexed([], []);

    expect(facts.expansion(B)).toEqual(INDEXING);
  });
});

describe('PluginFacts — a name under two origins reads its own plugin', () => {
  const MOD_A = { name: 'Shared.esp', origin: 'ModA' };
  const MOD_B = { name: 'Shared.esp', origin: 'ModB' };
  const sharedAt = (origin: string, overrides: Partial<PluginMetadata> = {}) => pluginMetadataFixture({ name: 'Shared.esp', origin, isCompiledPlugin: true, ...overrides });
  const bothHeld = (modB: Partial<PluginMetadata>): Scene => (facts) => facts.reconciled([sharedAt('ModA'), sharedAt('ModB', modB)], []);
  const CLEAN = {
    description: undefined, icon: undefined, tooltipLines: ['Shared.esp', 'ModA'], editable: true, hiddenByRecordFilter: false, expansion: RECORDS,
  };

  it.each<[string, Scene, Record<string, unknown>]>([
    ['master issues', bothHeld({ missingMasters: ['BMaster.esm'] }), {}],
    ['read-only', bothHeld({ isImmutable: true }), {}],
    ['unreadable records', bothHeld({ hasParseFailure: true }), {}],
    ['no matching records', bothHeld({ hasMatchingRecords: false }), {}],
    ['a diagnosis', scenes(bothHeld({}), (facts) => facts.diagnosed([diagnosis('ModB is malformed', MOD_B)])), {}],
    ['a failure to read', (facts) => facts.reconciled([sharedAt('ModA')], [failure('Malformed record', MOD_B)]), {}],
    ['a change outside Modbench', scenes(bothHeld({}), (facts) => changedOutside(facts, 'ModB', 'Shared.esp')), {}],
    ['its own failure to read, the other plugin loaded', (facts) => facts.reconciled([sharedAt('ModB')], [failure('Malformed record', MOD_A)]),
      { description: 'failed to read', icon: 'error', tooltipLines: ['Shared.esp', 'ModA', 'Failed to read: Malformed record'], editable: false, expansion: errorOf('Malformed record') }],
    ['only the other plugin held', (facts) => facts.reconciled([sharedAt('ModB')], []), { editable: false, expansion: INDEXING }],
    ['read-only and master issues, held under a third origin',
      (facts) => facts.reconciled([sharedAt('SomeOtherMod', { isImmutable: true, missingMasters: ['Ghost.esm'] })], []), { editable: false, expansion: INDEXING }],
    ['only the other plugin indexed', (facts) => facts.indexed([MOD_B], []), { editable: false, expansion: INDEXING }],
    ['only the other plugin failed in a tick', (facts) => facts.indexed([], [failure('Malformed record', MOD_B)]), { editable: false, expansion: INDEXING }],
  ])('is not touched by the other plugin\'s %s', (_label, scene, own) => {
    const facts = new PluginFacts();
    scene(facts);

    expect({
      description: facts.description(MOD_A), icon: facts.icon(MOD_A), tooltipLines: facts.tooltipLines(MOD_A),
      editable: facts.conditions(MOD_A).editable, hiddenByRecordFilter: facts.hiddenByRecordFilter(MOD_A), expansion: facts.expansion(MOD_A),
    }).toEqual({ ...CLEAN, ...own });
  });
});

describe('PluginFacts — the record index failure message (plugins.md, States, story 6)', () => {
  it.each([
    ['nothing holds', scenes(), undefined],
    ['the snapshot failed', (facts: PluginFacts) => facts.refused(failedIndex), 'Indexing failed: the record index threw'],
    ['another window holds the record index', (facts: PluginFacts) => facts.refused(heldElsewhere), undefined],
    ['another window after the failure', scenes((facts) => facts.refused(failedIndex), (facts) => facts.refused(heldElsewhere)), undefined],
    ['a tick after the failure', scenes((facts) => facts.refused(failedIndex), heldAOnly), undefined],
    ['the hand-off after the failure', scenes((facts) => facts.refused(failedIndex), (facts) => facts.reconciled([held()], [])), undefined],
  ] as const)('%s', (_label, scene, message) => {
    const facts = new PluginFacts();
    scene(facts);

    expect(facts.indexFailureMessage()).toBe(message);
  });
});

describe('PluginFacts — a read that failed (common.md, States, stories 2 and 6)', () => {
  const failing = held({ laterReadFailure: [{ sourceRelativePath: 'A.esp/Npc.json', message: 'Unexpected end at 12.' }, { sourceRelativePath: 'A.esp/Cell.json', message: 'Duplicate FormKey.' }] });

  it('says every failure, naming the plugin and each file and message', () => {
    const facts = new PluginFacts();
    facts.refreshed([failing, held({ name: 'B.esp', laterReadFailure: [{ sourceRelativePath: 'B.esp/X.json', message: 'bad' }] })]);

    expect(facts.readFailureMessage()).toBe(
      'Showing the last good read: "A.esp" (SomeMod): A.esp/Npc.json: Unexpected end at 12.; A.esp/Cell.json: Duplicate FormKey.; "B.esp" (SomeMod): B.esp/X.json: bad',
    );
  });

  describe.each([
    ['the malformed-plugin scan', (facts: PluginFacts) => facts.diagnosed([]), (facts: PluginFacts) => facts.scanFailed('503')],
    ["mEdit's facts about each plugin", (facts: PluginFacts) => facts.refreshed([]), (facts: PluginFacts) => facts.factsFailed('503')],
  ] as const)('%s', (read, answer, fail) => {
    it('says it failed to load when it failed before any answered', () => {
      const facts = new PluginFacts();

      fail(facts);

      expect(facts.readFailureMessage()).toBe(`Failed to load: ${read}: 503`);
    });

    it('says the last good read shows when it failed after one answered', () => {
      const facts = new PluginFacts();
      answer(facts);

      fail(facts);

      expect(facts.readFailureMessage()).toBe(`Showing the last good read: ${read}: 503`);
    });

    it('says nothing once the next read answers', () => {
      const facts = new PluginFacts();
      fail(facts);

      answer(facts);

      expect(facts.readFailureMessage()).toBeUndefined();
    });
  });

  it('puts the instance read failure and every failed read under one prefix', () => {
    const facts = new PluginFacts();
    facts.diagnosed([]);
    facts.refreshed([failing]);
    facts.scanFailed('503');

    expect(facts.readFailureMessage('mo2 gone')).toBe(
      'Showing the last good read: mo2 gone; "A.esp" (SomeMod): A.esp/Npc.json: Unexpected end at 12.; A.esp/Cell.json: Duplicate FormKey.; the malformed-plugin scan: 503',
    );
  });

  it.each([[null], [undefined]])('says nothing once the next read answers %s', (answer) => {
    const facts = new PluginFacts();
    facts.refreshed([failing]);

    facts.refreshed([held({ laterReadFailure: answer })]);

    expect(facts.readFailureMessage()).toBeUndefined();
  });
});

describe('placeOf — where a plugin lives, from the instance value', () => {
  const modOfOrigin = modOfOriginIn('SomeMod', 'SourceMod');
  const listedSourceMods = new Set(['SourceMod']);

  it.each<[string, string, PluginPlace | undefined]>([
    ['a mod without a repository', 'SomeMod', 'inNonSourceMod'],
    ['a mod with a repository', 'SourceMod', 'inSourceMod'],
    ['a mod named without case', 'sourcemod', 'inSourceMod'],
    ['Overwrite', 'overwrite/', 'inOverwrite'],
    ['the game folder', 'Data/', undefined],
    ['an origin no mod folder carries', 'Nowhere', undefined],
  ])('%s', (_label, origin, place) => {
    expect(placeOf(origin, { modOfOrigin, listedSourceMods })).toBe(place);
  });
});
