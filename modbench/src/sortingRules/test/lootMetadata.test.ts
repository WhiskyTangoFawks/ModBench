import { describe, expect, it } from 'vitest';
import { rulesReader, type SortingRuleFiles } from '../lootMetadata';

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
    expect(entries).toEqual([expect.objectContaining({ group: 'late' })]);
    expect(groups).toEqual([
      { name: 'default', after: [] },
      { name: 'early', after: [] },
      { name: 'late', after: [{ name: 'default', source: { file: 'masterlist', line: 4 } }, { name: 'early', source: { file: 'masterlist', line: 4 } }] },
    ]);
  });

  it('reports, on its line, a group after that is no name, and one naming a group no file declares, and reads no edge for it', () => {
    const { groups, problems } = readRules(filesOf({
      masterlist: text('groups:\n  - name: default\n  - name: late\n    after: [default, ghost, {x: 1}]\n'),
      userlist: text('groups:\n  - name: late\n    after: [phantom, default]\n'),
    }));

    expect(problems).toEqual([
      { file: 'masterlist', line: 3, text: 'An entry of "after" has no name.' },
      { file: 'masterlist', line: 3, text: 'The group "late" loads after "ghost", which no file declares.' },
      { file: 'userlist', line: 2, text: 'The group "late" loads after "phantom", which no file declares.' },
    ]);
    expect(groups.flatMap(({ after }) => after.map(({ name }) => name))).toEqual(['default', 'default']);
  });
});
