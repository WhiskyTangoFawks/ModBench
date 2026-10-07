import { describe, it, expect } from 'vitest';
import type { PluginDiagnosisReport, PluginLoadFailure, PluginMetadata } from '../../client';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { PluginFacts, placeOf, type PluginPlace } from '../pluginFacts';

const A = { name: 'A.esp', origin: 'SomeMod' };

const held = (overrides: Partial<PluginMetadata> = {}): PluginMetadata => pluginMetadataFixture({ name: 'A.esp', ...overrides });
const failure = (reason: string, address = A): PluginLoadFailure => ({ ...address, reason });
const diagnosis = (text: string, address = A): PluginDiagnosisReport => (
  { plugin: address.name, origin: address.origin, defectClass: 'fixed-size-subrecord-short', message: text, text }
);
const changedOutside = (facts: PluginFacts, origin: string, ...names: string[]): void => facts.externalChange({
  origin, changedPlugins: names.map((name) => ({ name, bytesSha256: 'ab12' })),
});

const CHANGED_TEXT = 'Changed outside Modbench: its bytes differ from what Modbench last wrote.';

type Scene = (facts: PluginFacts) => void;

const failed: Scene = (facts) => facts.reconciled([], [failure('Malformed record')]);
const masters = (...missing: string[]): Scene => (facts) => facts.reconciled([held({ masterIssues: missing })], []);
const unreadable: Scene = (facts) => facts.reconciled([held({ hasParseFailure: true })], []);
const changed: Scene = (facts) => changedOutside(facts, 'SomeMod', 'A.esp');
const malformed: Scene = (facts) => facts.diagnosed([diagnosis('first'), diagnosis('second')]);
const scenes = (...parts: Scene[]): Scene => (facts) => parts.forEach((part) => part(facts));

describe('PluginFacts — the status table (plugins.md, A row, Plugin)', () => {
  it.each([
    ['nothing', scenes(), undefined, undefined, []],
    ['failed to read', failed, 'error', 'failed to read', ['Failed to read: Malformed record']],
    ['one master issue', masters('Ghost.esm'), 'error', '1 master issue', ['Missing masters: Ghost.esm']],
    ['two master issues', masters('Ghost.esm', 'Off.esm'), 'error', '2 master issues', ['Missing masters: Ghost.esm, Off.esm']],
    ['no master issues', masters(), undefined, undefined, []],
    ['unreadable records', unreadable, 'error', 'unreadable records',
      ['This plugin holds a record that could not be read into its document.']],
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
    facts.reconciled([held({ hasParseFailure: true, masterIssues: ['Ghost.esm'] })], [failure('Malformed record')]);

    expect(facts.description(A)).toBe('failed to read, 1 master issue, unreadable records, changed outside Modbench, malformed');
    expect(facts.statuses(A).map((s) => s.kind)).toEqual(
      ['failedToRead', 'masterIssues', 'unreadableRecords', 'changedOutside', 'malformed'],
    );
  });

  it('carries the read-only line between the origin and the status lines', () => {
    const facts = new PluginFacts();
    facts.reconciled([held({ isImmutable: true, masterIssues: ['Ghost.esm'] })], []);

    expect(facts.tooltipLines(A)).toEqual(['A.esp', 'SomeMod', 'read-only', 'Missing masters: Ghost.esm']);
  });

  it.each([
    ['a plugin named in no answer', { name: 'B.esp', origin: 'SomeMod' }],
    ['the same plugin file name of another origin', { name: 'A.esp', origin: 'OtherMod' }],
  ])('shows nothing on %s', (_label, address) => {
    const facts = new PluginFacts();
    scenes(failed, masters('Ghost.esm'), unreadable, changed, malformed)(facts);

    expect(facts.statuses(address)).toEqual([]);
  });

  it.each([
    ['load failure', (facts: PluginFacts) => facts.reconciled([], [failure('x', { name: 'A.ESP', origin: 'SOMEMOD' })])],
    ['master issues', (facts: PluginFacts) => facts.reconciled([held({ name: 'a.ESP', origin: 'somemod', masterIssues: ['G.esm'] })], [])],
    ['parse failure', (facts: PluginFacts) => facts.reconciled([held({ name: 'a.ESP', origin: 'somemod', hasParseFailure: true })], [])],
    ['changed outside', (facts: PluginFacts) => changedOutside(facts, 'SOMEMOD', 'a.ESP')],
    ['diagnosis', (facts: PluginFacts) => facts.diagnosed([diagnosis('x', { name: 'A.ESP', origin: 'SOMEMOD' })])],
  ])('joins a %s to the plugin by name and origin without case', (_label, scene) => {
    const facts = new PluginFacts();
    scene(facts);

    expect(facts.statuses(A)).toHaveLength(1);
  });
});

describe('PluginFacts — which statuses stay and which land (plugins.md, A row, bullets)', () => {
  it('shows no master status while mEdit has not checked, which is not no issues', () => {
    const facts = new PluginFacts();
    facts.reconciled([held({ masterIssues: null })], []);

    expect(facts.statuses(A)).toEqual([]);
  });

  it.each([
    ['unchecked', null, 'Missing masters: Ghost.esm'],
    ['checked and clean', [], undefined],
    ['checked and changed', ['Other.esm'], 'Missing masters: Other.esm'],
  ])('keeps the last master issues until a snapshot is indexed: a re-read that is %s', (_label, next, line) => {
    const facts = new PluginFacts();
    facts.reconciled([held({ masterIssues: ['Ghost.esm'] })], []);

    facts.refreshed([held({ masterIssues: next })]);

    expect(facts.tooltipLines(A).slice(2)).toEqual(line === undefined ? [] : [line]);
  });

  it('forgets the last master issues of a plugin a re-read omits', () => {
    const facts = new PluginFacts();
    facts.reconciled([held({ masterIssues: ['Ghost.esm'] })], []);

    facts.refreshed([]);
    facts.refreshed([held({ masterIssues: null })]);

    expect(facts.statuses(A)).toEqual([]);
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

    expect(facts.statuses(A).map((s) => s.words)).toEqual(['failed to read']);
    expect(facts.statuses(B).map((s) => s.words)).toEqual(['failed to read']);
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

  it('lists exactly the plugins whose rows carry the changed outside status', () => {
    const facts = new PluginFacts();
    changedOutside(facts, 'SomeMod', 'A.esp', 'B.esp');

    const warned = facts.problems().changedOutside.map((w) => ({ name: w.plugin, origin: w.origin }));
    expect(warned).toHaveLength(2);
    expect(warned.every((address) => facts.statuses(address).some((s) => s.kind === 'changedOutside'))).toBe(true);
  });
});

describe('PluginFacts — what a row states about its plugin', () => {
  it.each([
    ['nothing before mEdit answers', undefined, [], { tracked: false, editable: false }],
    ['an untracked, editable plugin', { isTracked: false }, ['untracked', 'editable'], { tracked: false, editable: true }],
    ['a tracked, editable plugin', { isTracked: true }, ['tracked', 'editable'], { tracked: true, editable: true }],
    ['a tracked, read-only plugin', { isTracked: true, isImmutable: true }, ['tracked'], { tracked: true, editable: false }],
    ['an untracked, read-only plugin', { isImmutable: true }, ['untracked'], { tracked: false, editable: false }],
  ] as const)('%s', (_label, overrides, flags, conditions) => {
    const facts = new PluginFacts();
    if (overrides !== undefined) facts.reconciled([held(overrides)], []);

    expect(facts.contextFlags(A)).toEqual(flags);
    expect(facts.conditions(A)).toEqual(conditions);
  });

  it('answers compile for any plugin tracked, a read-only one included', () => {
    const facts = new PluginFacts();
    expect(facts.anyCompilable()).toBe(false);

    facts.reconciled([held(), held({ name: 'B.esp' })], []);
    expect(facts.anyCompilable()).toBe(false);

    facts.reconciled([held(), held({ name: 'B.esp', isTracked: true, isImmutable: true })], []);
    expect(facts.anyCompilable()).toBe(true);
  });
});

describe('PluginFacts — which plugins mEdit holds and the record filter', () => {
  it('holds the plugins of the last tick or reconcile, by origin', () => {
    const facts = new PluginFacts();
    facts.indexed([A], []);

    expect(facts.isHeld(A)).toBe(true);
    expect(facts.isHeld({ name: 'A.esp', origin: 'OtherMod' })).toBe(false);

    facts.indexed([], []);
    expect(facts.isHeld(A)).toBe(false);
  });

  it.each([
    ['one with matches among others without', [true, false], [false, true], false],
    ['every plugin without', [false, false], [true, true], true],
    ['no plugin at all', [], [], false],
  ])('%s', (_label, answers, hidden, matchesNothing) => {
    const facts = new PluginFacts();
    facts.refreshed(answers.map((hasMatchingRecords, i) => held({ name: `P${i}.esp`, hasMatchingRecords })));

    expect(answers.map((_, i) => facts.hiddenByRecordFilter({ name: `P${i}.esp`, origin: 'SomeMod' }))).toEqual(hidden);
    expect(facts.recordFilterMatchesNothing()).toBe(matchesNothing);
  });

  it('hides nothing and matches something while mEdit has not said', () => {
    const facts = new PluginFacts();

    expect(facts.hiddenByRecordFilter(A)).toBe(false);
    expect(facts.recordFilterMatchesNothing()).toBe(false);
  });
});

const heldElsewhere = { kind: 'heldElsewhere', message: 'another window holds this instance' } as const;
const failedIndex = { kind: 'failed', message: 'the index threw' } as const;
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
    ['another window holds the index', scenes(heldAOnly, (facts) => facts.refused(heldElsewhere)),
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

describe('PluginFacts — the view message line (plugins.md, States, stories 1, 5 and 6)', () => {
  const none = { gameFolderMessage: undefined, noRowsMessage: undefined, recordFilterSource: undefined };

  it.each([
    ['nothing holds', scenes(), none, undefined],
    ['the game folder is missing', scenes(), { ...none, gameFolderMessage: 'no game folder' }, 'no game folder'],
    ['no rows', scenes(), { ...none, noRowsMessage: 'no plugins' }, 'no plugins'],
    ['the snapshot failed', (facts: PluginFacts) => facts.refused(failedIndex), none, 'Indexing failed: the index threw'],
    ['another window holds the index', (facts: PluginFacts) => facts.refused(heldElsewhere), none, undefined],
    ['another window after the failure', scenes((facts) => facts.refused(failedIndex), (facts) => facts.refused(heldElsewhere)),
      none, undefined],
    ['a tick after the failure', scenes((facts) => facts.refused(failedIndex), heldAOnly), none, undefined],
    ['the hand-off after the failure', scenes((facts) => facts.refused(failedIndex), (facts) => facts.reconciled([held()], [])),
      none, undefined],
    ['the game folder over the failure', (facts: PluginFacts) => facts.refused(failedIndex),
      { ...none, gameFolderMessage: 'no game folder' }, 'no game folder'],
    ['the failure over no rows', (facts: PluginFacts) => facts.refused(failedIndex),
      { ...none, noRowsMessage: 'no plugins' }, 'Indexing failed: the index threw'],
    ['a filter matching nothing', (facts: PluginFacts) => facts.reconciled([held({ hasMatchingRecords: false })], []),
      { ...none, recordFilterSource: 'weapon' }, 'No records match weapon.'],
    ['a filter matching something', (facts: PluginFacts) => facts.reconciled([held()], []),
      { ...none, recordFilterSource: 'weapon' }, undefined],
    ['no rows over a filter matching nothing', (facts: PluginFacts) => facts.reconciled([held({ hasMatchingRecords: false })], []),
      { ...none, noRowsMessage: 'no plugins', recordFilterSource: 'weapon' }, 'no plugins'],
  ] as const)('%s', (_label, scene, inputs, message) => {
    const facts = new PluginFacts();
    scene(facts);

    expect(facts.heldMessage(inputs)).toBe(message);
  });
});

describe('placeOf — where a plugin lives, from the instance value', () => {
  const modDirs = new Map([['SomeMod', '/mods/SomeMod'], ['TrackedMod', '/mods/TrackedMod']]);
  const trackedMods = new Set(['TrackedMod']);

  it.each<[string, string, PluginPlace | undefined]>([
    ['a mod without a repository', 'SomeMod', 'inUntrackedMod'],
    ['a mod with a repository', 'TrackedMod', 'inTrackedMod'],
    ['a mod named without case', 'trackedmod', 'inTrackedMod'],
    ['Overwrite', 'overwrite', 'inOverwrite'],
    ['the game folder', 'Data', undefined],
    ['an origin no mod folder carries', 'Nowhere', undefined],
  ])('%s', (_label, origin, place) => {
    expect(placeOf(origin, { modDirs, trackedMods })).toBe(place);
  });
});
