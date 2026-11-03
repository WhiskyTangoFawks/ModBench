import { describe, expect, it } from 'vitest';
import { addLoadAfter, metadataProblem, rulesReader, type MetadataTexts, type SortingRuleFiles } from '../lootMetadata';

const readRules = (files: SortingRuleFiles) => rulesReader()(files);
type SortingRuleFile = SortingRuleFiles['masterlist'];
const text = (body: string): SortingRuleFile => ({ path: '/instance/f.yaml', kind: 'text', text: body });
const ABSENT: SortingRuleFile = { path: '/instance/f.yaml', kind: 'absent' };
const filesOf = (parts: Partial<SortingRuleFiles>): SortingRuleFiles => ({ masterlist: ABSENT, prelude: ABSENT, userlist: ABSENT, ...parts });

describe('readRules: LOOT\'s masterlist, prelude and userlist as sorting rules', () => {
  it('reads a plugin\'s requirements, incompatibilities, load afters and messages', () => {
    const { entries, problems } = readRules(filesOf({ masterlist: text(`plugins:
  - name: 'A.esp'
    req:
      - 'B.esp'
      - name: 'C.esp'
        display: 'Mod C'
        detail: 'Get it.'
    inc: [D.esp]
    after: [E.esp]
    msg:
      - type: warn
        content: 'Be careful.'
`) }));

    expect(problems).toEqual([]);
    expect(entries).toEqual([expect.objectContaining({
      name: 'A.esp',
      req: [{ name: 'B.esp', source: { file: 'masterlist', line: 3 } }, { name: 'C.esp', display: 'Mod C', detail: 'Get it.', source: { file: 'masterlist', line: 4 } }],
      inc: [{ name: 'D.esp', source: { file: 'masterlist', line: 7 } }],
      after: [{ name: 'E.esp', source: { file: 'masterlist', line: 8 } }],
      msg: [{ level: 'warning', text: 'Be careful.', source: { file: 'masterlist', line: 10 } }],
    })]);
  });

  it('reads a say message as Info, a warn as Warning and an error as Error', () => {
    const { entries } = readRules(filesOf({ masterlist: text(`plugins:
  - name: A.esp
    msg:
      - {type: say, content: s}
      - {type: warn, content: w}
      - {type: error, content: e}
`) }));

    expect(entries[0]?.msg.map(({ level }) => level)).toEqual(['info', 'warning', 'error']);
  });

  it('takes the English text of a localised content list, with its substitutions', () => {
    const { entries } = readRules(filesOf({ masterlist: text(`plugins:
  - name: A.esp
    msg:
      - type: say
        content:
          - {lang: de, text: 'Siehe {0}.'}
          - {lang: en, text: 'See {0}.'}
        subs: ['B.esp']
`) }));

    expect(entries[0]?.msg[0]?.text).toBe('See B.esp.');
  });

  it('keeps a condition with the data it guards', () => {
    const { entries } = readRules(filesOf({ masterlist: text(`plugins:
  - name: A.esp
    req: [{name: B.esp, condition: 'active("C.esp")'}]
    msg: [{type: say, content: m, condition: 'file("D.esp")'}]
`) }));

    expect([entries[0]?.req[0]?.condition, entries[0]?.msg[0]?.condition]).toEqual(['active("C.esp")', 'file("D.esp")']);
  });

  it('matches an exact name without case, and a regex name against the whole file name', () => {
    const { entries } = readRules(filesOf({ masterlist: text(`plugins:
  - name: 'Exact.esp'
  - name: 'Patch-\\d+\\.esp'
`) }));
    const [exact, regex] = entries;

    expect([exact?.matches('exact.ESP'), exact?.matches('exact.espx'), regex?.matches('patch-12.esp'), regex?.matches('xpatch-12.esp')])
      .toEqual([true, false, true, false]);
  });

  it('puts the userlist\'s entries after the masterlist\'s, each stating its own file and line', () => {
    const { entries } = readRules(filesOf({
      masterlist: text('plugins:\n  - name: A.esp\n    inc: [X.esp]\n'),
      userlist: text('plugins:\n  - name: A.esp\n    after: [Y.esp]\n'),
    }));

    expect(entries.map(({ name, after, inc }) => [name, after[0]?.source, inc[0]?.source]))
      .toEqual([['A.esp', undefined, { file: 'masterlist', line: 2 }], ['A.esp', { file: 'userlist', line: 2 }, undefined]]);
  });

  it('resolves the anchors a masterlist takes from the prelude', () => {
    const { entries, problems } = readRules(filesOf({
      masterlist: text('prelude:\n  - &old stale\nplugins:\n  - name: A.esp\n    msg:\n      - *shared\n'),
      prelude: text('- &shared\n  type: error\n  content: from the prelude\n'),
    }));

    expect([problems, entries[0]?.msg[0]?.text]).toEqual([[], 'from the prelude']);
  });

  it('merges a YAML merge key', () => {
    const { entries } = readRules(filesOf({ masterlist: text(`prelude:
  - &base {type: warn}
plugins:
  - name: A.esp
    msg:
      - <<: *base
        content: merged
`) }));

    expect(entries[0]?.msg[0]).toEqual(expect.objectContaining({ level: 'warning', text: 'merged' }));
  });

  it('reads no rule from a file that is absent, and reports no problem for it', () => {
    expect(readRules(filesOf({}))).toMatchObject({ entries: [], problems: [] });
  });

  it('names a file that is not YAML, with the line, and reads the others', () => {
    const { entries, problems } = readRules(filesOf({
      masterlist: text('plugins:\n  - name: A.esp\n    inc: [\n'),
      userlist: text('plugins:\n  - name: B.esp\n'),
    }));

    expect([entries.map(({ name }) => name), problems.map(({ file, line }) => [file, line])]).toEqual([['B.esp'], [['masterlist', expect.any(Number)]]]);
  });

  it('names an entry that has no name, on its line, and keeps the rest of the file', () => {
    const { entries, problems } = readRules(filesOf({ userlist: text('plugins:\n  - name: A.esp\n  - after: [B.esp]\n  - name: C.esp\n') }));

    expect([entries.map(({ name }) => name), problems]).toEqual([['A.esp', 'C.esp'], [{ file: 'userlist', line: 2, text: 'A plugin entry has no name.' }]]);
  });

  it('names a regex name that does not compile, on its line', () => {
    const { entries, problems } = readRules(filesOf({ userlist: text('plugins:\n  - name: \'(unclosed\\.esp\'\n') }));

    expect([entries, problems.map(({ file, line }) => [file, line])]).toEqual([[], [['userlist', 1]]]);
  });

  it('names a message with an unknown type, or no content, on its line', () => {
    const { entries, problems } = readRules(filesOf({ userlist: text('plugins:\n  - name: A.esp\n    msg:\n      - {type: shout, content: x}\n      - {type: say}\n') }));

    expect([entries[0]?.msg, problems.map(({ line }) => line)]).toEqual([[], [3, 4]]);
  });

  it('names a file whose aliases expand without end as not read, instead of expanding them', () => {
    const levels = Array.from({ length: 10 }, (_, i) => `  - &l${i + 1} [${Array.from({ length: 10 }, () => `*l${i}`).join(', ')}]`);
    const bomb = `plugins: []\nl:\n  - &l0 [a, b]\n${levels.join('\n')}\n  - name: X\n`;
    const { entries, problems } = readRules(filesOf({ userlist: text(bomb) }));

    expect([entries, problems.map(({ file }) => file)]).toEqual([[], ['userlist']]);
  });

  it('names a file that could not be read, without a line', () => {
    const { problems } = readRules(filesOf({ userlist: { path: '/instance/userlist.yaml', kind: 'unreadable', reason: 'EACCES' } }));

    expect(problems).toEqual([{ file: 'userlist', text: 'EACCES' }]);
  });
});

describe('rulesReader', () => {
  it('answers the same reading while the files hold what they held, and a new one when one changes', () => {
    const read = rulesReader();
    const first = read(filesOf({ userlist: text('plugins: []\n') }));

    expect([read(filesOf({ userlist: text('plugins: []\n') })) === first, read(filesOf({ userlist: text('plugins:\n  - name: A.esp\n') })) === first]).toEqual([true, false]);
  });

  it('reads a plugin\'s group and the groups, each with the line of each group it loads after', () => {
    const { entries, groups, problems } = readRules(filesOf({ masterlist: text(`groups:
  - name: default
  - name: early
  - name: late
    after: [default, early]
plugins:
  - name: A.esp
    group: late
`) }));

    expect(problems).toEqual([]);
    expect(entries).toEqual([expect.objectContaining({ group: { name: 'late', source: { file: 'masterlist', line: 7 } } })]);
    expect(groups).toEqual([
      { name: 'default', after: [] },
      { name: 'early', after: [] },
      { name: 'late', after: [{ name: 'default', source: { file: 'masterlist', line: 4 } }, { name: 'early', source: { file: 'masterlist', line: 4 } }] },
    ]);
  });

  it('reports an after item that is not a name, on its line, and reads no edge for it', () => {
    const { groups, problems } = readRules(filesOf({ masterlist: text('groups:\n  - name: default\n  - name: late\n    after: [default, {x: 1}]\n') }));

    expect(problems).toEqual([{ file: 'masterlist', line: 3, text: 'An entry of "after" is not a name.' }]);
    expect(groups.flatMap(({ after }) => after.map(({ name }) => name))).toEqual(['default']);
  });

  it('reports a group item that is no mapping, on its line', () => {
    expect(readRules(filesOf({ masterlist: text('groups:\n  - late\n') })).problems).toEqual([{ file: 'masterlist', line: 1, text: 'A group is not a mapping.' }]);
  });

  it('reports an after naming a group no file declares, in the file and on the line that states it, and reads no edge for it', () => {
    const { groups, problems } = readRules(filesOf({
      masterlist: text('groups:\n  - name: late\n    after: [ghost]\n'),
      userlist: text('groups:\n  - name: late\n    after: [phantom]\n'),
    }));

    expect(problems).toEqual([
      { file: 'userlist', line: 2, text: 'The group "late" loads after "phantom", which no file declares.' },
      { file: 'masterlist', line: 2, text: 'The group "late" loads after "ghost", which no file declares.' },
    ]);
    expect(groups.flatMap(({ after }) => after)).toEqual([]);
  });

  it('declares the default group whatever the files hold, and a group the other file declares', () => {
    const { problems } = readRules(filesOf({
      masterlist: text('groups:\n  - name: late\n'),
      userlist: text('groups:\n  - name: early\n    after: [default, late]\n'),
    }));

    expect(problems).toEqual([]);
  });

  it('reports a plugin whose group no file declares, on the line of its group', () => {
    const { problems } = readRules(filesOf({ masterlist: text('plugins:\n  - name: A.esp\n    group: ghost\n') }));

    expect(problems).toEqual([{ file: 'masterlist', line: 2, text: 'This plugin belongs to the group "ghost", which does not exist.' }]);
  });

  it('reports groups that load after each other in a cycle, naming it on the line that closes it, and reads no edge of the cycle', () => {
    const { groups, problems } = readRules(filesOf({ masterlist: text('groups:\n  - {name: a, after: [b]}\n  - {name: b, after: [a]}\n  - {name: c, after: [a]}\n') }));

    expect(problems).toEqual([{ file: 'masterlist', line: 2, text: 'The groups load after each other in a cycle: a after b after a.' }]);
    expect(groups.map(({ name, after }) => [name, after.map((step) => step.name)])).toEqual([['a', []], ['b', []], ['c', ['a']]]);
  });

  it('reports a plugin group that is not a name, on its line', () => {
    const { entries, problems } = readRules(filesOf({ masterlist: text('plugins:\n  - name: A.esp\n    group: [late]\n') }));

    expect(problems).toEqual([{ file: 'masterlist', line: 2, text: 'A plugin\'s group is not a name.' }]);
    expect(entries[0]?.group).toBeUndefined();
  });

  it('reads a group the two files state once, its userlist afters first', () => {
    const { groups } = readRules(filesOf({
      masterlist: text('groups:\n  - {name: early}\n  - {name: aside}\n  - {name: late, after: [early]}\n'),
      userlist: text('groups:\n  - {name: late, after: [aside]}\n'),
    }));

    expect(groups.filter(({ name }) => name === 'late').map(({ after }) => after.map((step) => step.name))).toEqual([['aside', 'early']]);
  });
});

describe('a load after written into the userlist', () => {
  it('makes the userlist of an absent file', () => {
    expect(addLoadAfter('', [{ plugin: 'A.esp', after: ['B.esp', 'C.esp'] }])).toBe(`plugins:
  - name: A.esp
    after:
      - B.esp
      - C.esp
`);
  });

  it('writes what readRules reads back as the load afters', () => {
    const written = addLoadAfter('', [{ plugin: 'A.esp', after: ['B.esp'] }, { plugin: 'D.esp', after: ['B.esp'] }]);

    const { entries, problems } = readRules(filesOf({ userlist: text(written) }));

    expect(problems).toEqual([]);
    expect(entries.map(({ name, after }) => [name, after.map((file) => file.name)])).toEqual([['A.esp', ['B.esp']], ['D.esp', ['B.esp']]]);
  });

  it('keeps a comment and an anchor the file holds', () => {
    const original = `# my rules
groups: &groups
  - name: late
plugins:
  - name: X.esp # keep
    after: [Y.esp]
`;

    const written = addLoadAfter(original, [{ plugin: 'A.esp', after: ['B.esp'] }]);

    expect(written.startsWith(original.trimEnd())).toBe(true);
    expect(written).toContain('name: A.esp');
  });

  it('adds to the entry the plugin has, matching its name in any case', () => {
    const written = addLoadAfter('plugins:\n  - name: a.ESP\n    after: [Y.esp]\n', [{ plugin: 'A.esp', after: ['B.esp'] }]);

    const { entries } = readRules(filesOf({ userlist: text(written) }));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.after.map((file) => file.name)).toEqual(['Y.esp', 'B.esp']);
  });

  it('adds an after to an entry that has none', () => {
    const written = addLoadAfter('plugins:\n  - name: A.esp\n    msg: [{type: say, content: hi}]\n', [{ plugin: 'A.esp', after: ['B.esp'] }]);

    const { entries } = readRules(filesOf({ userlist: text(written) }));

    expect(entries[0]?.after.map((file) => file.name)).toEqual(['B.esp']);
    expect(entries[0]?.msg).toHaveLength(1);
  });

  it('returns the text unchanged when it holds every rule, whether the after is a name or a map, in any case', () => {
    const original = "plugins:\n  - name: A.esp\n    after:\n      - b.ESP\n      - {name: C.esp, display: c}\n";

    expect(addLoadAfter(original, [{ plugin: 'A.esp', after: ['B.esp', 'C.esp'] }])).toBe(original);
  });

  it('adds only the afters the entry lacks', () => {
    const written = addLoadAfter('plugins:\n  - name: A.esp\n    after: [B.esp]\n', [{ plugin: 'A.esp', after: ['B.esp', 'C.esp'] }]);

    const { entries } = readRules(filesOf({ userlist: text(written) }));

    expect(entries[0]?.after.map((file) => file.name)).toEqual(['B.esp', 'C.esp']);
  });

  it('changes only the entry it edits: spacing, a trailing comment and the other entries stay as written', () => {
    const other = "plugins:\n  - {name: 'X.esp', after: [ Y.esp ]}  # mine\n";
    const edited = "  - name: A.esp\n    after: [ B.esp ] # why\n";

    const written = addLoadAfter(other + edited, [{ plugin: 'A.esp', after: ['C.esp'] }]);

    expect(written).toBe(other + "  - name: A.esp\n    after: [ B.esp, C.esp ] # why\n");
  });

  it('adds to a block list after its last item, before a comment on that line', () => {
    const written = addLoadAfter('plugins:\n  - name: A.esp\n    after:\n      - B.esp # why\n# end\n', [{ plugin: 'A.esp', after: ['C.esp'] }]);

    expect(written).toBe('plugins:\n  - name: A.esp\n    after:\n      - B.esp # why\n      - C.esp\n# end\n');
  });

  it('keeps the line endings the file uses', () => {
    const written = addLoadAfter('plugins:\r\n  - name: A.esp\r\n', [{ plugin: 'A.esp', after: ['B.esp'] }]);

    expect(written).toBe('plugins:\r\n  - name: A.esp\r\n    after:\r\n      - B.esp\r\n');
  });

  it('adds an entry to an empty flow list of plugins', () => {
    expect(addLoadAfter('plugins: []\n', [{ plugin: 'A.esp', after: ['B.esp'] }])).toBe('plugins: [{name: A.esp, after: [B.esp]}]\n');
  });

  it('quotes a name YAML would read as something else', () => {
    const written = addLoadAfter('', [{ plugin: 'A: B.esp', after: ['# C.esp'] }]);

    const { entries } = readRules(filesOf({ userlist: text(written) }));

    expect(entries.map(({ name, after }) => [name, after.map((file) => file.name)])).toEqual([['A: B.esp', ['# C.esp']]]);
  });

  it.each(['', '# only a comment\n'])('returns %j unchanged for no rule', (original) => {
    expect(addLoadAfter(original, [])).toBe(original);
  });

  it.each(['- just\n- a list\n', 'plugins: [unclosed', 'plugins: ~\n', 'plugins: 3\n'])('rejects %j, writing nothing', (original) => {
    expect(() => addLoadAfter(original, [{ plugin: 'A.esp', after: ['B.esp'] }])).toThrow();
  });

  it('writes a name longer than a line as one scalar the file still parses', () => {
    const long = `${'Long name '.repeat(12)}.esp`;

    const written = addLoadAfter('', [{ plugin: long, after: [long + ' too'] }]);

    const { entries, problems } = readRules(filesOf({ userlist: text(written) }));
    expect(problems).toEqual([]);
    expect(entries.map(({ name, after }) => [name, after.map((file) => file.name)])).toEqual([[long, [long + ' too']]]);
  });

  it.each([
    ['an entry the file lacks', ''],
    ['an entry it holds', 'plugins:\n  - name: A.esp\n    after: [Z.esp]\n'],
    ['an entry it holds with no after', 'plugins:\n  - name: A.esp\n'],
  ])('merges a plugin named twice in one call, for %s', (_, original) => {
    const written = addLoadAfter(original, [{ plugin: 'A.esp', after: ['B.esp'] }, { plugin: 'a.ESP', after: ['C.esp', 'b.esp'] }]);

    const { entries, problems } = readRules(filesOf({ userlist: text(written) }));
    expect(problems).toEqual([]);
    expect(entries.map(({ after }) => after.map((file) => file.name).filter((name) => name !== 'Z.esp'))).toEqual([['B.esp', 'C.esp']]);
  });

  it.each([
    ['a file holding only a comment', '# mine\n', '# mine\nplugins:\n  - name: A.esp\n    after:\n      - B.esp\n'],
    ['a bare plugins key', 'plugins:\n', 'plugins:\n  - name: A.esp\n    after:\n      - B.esp\n'],
    ['a bare plugins key with a comment', 'groups: []\nplugins: # mine\nmore: 1\n', 'groups: []\nplugins: # mine\n  - name: A.esp\n    after:\n      - B.esp\nmore: 1\n'],
  ])('adds the plugins list after %s', (_, original, expected) => {
    expect(addLoadAfter(original, [{ plugin: 'A.esp', after: ['B.esp'] }])).toBe(expected);
  });

  it('adds the plugins list before a document end marker, not in a second document', () => {
    expect(addLoadAfter('# mine\n...\n', [{ plugin: 'A.esp', after: ['B.esp'] }])).toBe('# mine\nplugins:\n  - name: A.esp\n    after:\n      - B.esp\n...\n');
    expect(addLoadAfter('groups: []\n...\n', [{ plugin: 'A.esp', after: ['B.esp'] }])).toBe('groups: []\nplugins:\n  - name: A.esp\n    after:\n      - B.esp\n...\n');
  });

  it('adds an after beyond the blank lines a keep block scalar holds, so its text is unchanged', () => {
    const original = 'plugins:\n  - name: A.esp\n    msg:\n      - type: say\n        content: |+\n          hi\n\n\n';

    const written = addLoadAfter(original, [{ plugin: 'A.esp', after: ['B.esp'] }]);

    const { entries, problems } = readRules(filesOf({ userlist: text(written) }));
    expect(problems).toEqual([]);
    expect(entries[0]?.msg[0]?.text).toBe('hi\n\n\n');
    expect(entries[0]?.after.map((file) => file.name)).toEqual(['B.esp']);
  });
});

describe('metadataProblem: whether texts read as LOOT\'s masterlist and prelude', () => {
  const MASTERLIST = 'plugins:\n  - name: A.esp\n';
  const PRELUDE = '- &anchor x\n';

  it.each<[string, MetadataTexts, string]>([
    ['a masterlist that is a page of HTML', { masterlist: '<!DOCTYPE html>\n<html><body>Sign in to the network</body></html>\n', prelude: PRELUDE }, 'The masterlist is not LOOT metadata.'],
    ['a masterlist that is a map of no LOOT key', { masterlist: 'title: Sign in\nmessage: the network needs you to log in\n', prelude: PRELUDE }, 'The masterlist is not LOOT metadata.'],
    ['a prelude that is a page of HTML', { masterlist: MASTERLIST, prelude: '<html><body>Sign in</body></html>\n' }, 'The prelude is not LOOT metadata.'],
    ['a masterlist that is not YAML', { masterlist: 'plugins: [unclosed\n', prelude: PRELUDE }, 'The masterlist does not read: '],
    ['a masterlist with an alias no anchor defines', { masterlist: 'plugins:\n  - *missing\n', prelude: PRELUDE }, 'The masterlist does not read: '],
  ])('names %s', (_case, texts, start) => {
    expect(metadataProblem(texts)?.startsWith(start)).toBe(true);
  });

  it('finds none in a masterlist and prelude that read, the masterlist using the prelude\'s anchors', () => {
    expect(metadataProblem({ masterlist: 'prelude:\nplugins:\n  - name: A.esp\n    after: [*anchor]\n', prelude: PRELUDE })).toBeUndefined();
  });
});
