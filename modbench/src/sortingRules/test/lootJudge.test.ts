import { describe, expect, it } from 'vitest';
import { judgeLoot, type LootPartition } from '../lootJudge';
import { rulesReader, type SortingRuleFiles } from '../lootMetadata';

const readRules = (files: SortingRuleFiles) => rulesReader()(files);
type SortingRuleFile = SortingRuleFiles['masterlist'];
const text = (body: string): SortingRuleFile => ({ path: '/instance/f.yaml', kind: 'text', text: body });
const ABSENT: SortingRuleFile = { path: '/instance/f.yaml', kind: 'absent' };
const rules = (parts: Partial<SortingRuleFiles>) => readRules({ masterlist: ABSENT, prelude: ABSENT, userlist: ABSENT, ...parts });
const at = (filename: string) => ({ origin: 'Mod', filename });

const judged = (order: string[], masterlist: string, present: string[] = order, userlist?: string, partitions: Record<string, LootPartition> = {}) =>
  judgeLoot(order.map(at), {
    ...rules({ masterlist: text(masterlist), ...userlist === undefined ? {} : { userlist: text(userlist) } }),
    isPresent: (filename) => present.some((name) => name.toLowerCase() === filename.toLowerCase()),
  }, (filename) => partitions[filename] ?? 'nonMasters');

describe('judgeLoot: LOOT\'s rules held against a plugin order', () => {
  it('breaks, at Error, a plugin whose requirement is not present, naming its display and detail', () => {
    const broken = judged(['A.esp'], `plugins:
  - name: A.esp
    req:
      - {name: B.esp, display: Mod B, detail: Install it.}
`);

    expect(broken).toEqual([{
      rule: 'requirement', level: 'error', plugins: [at('A.esp')], source: { file: 'masterlist', line: 3 },
      reason: '"A.esp" requires Mod B, which is missing. Install it.',
    }]);
  });

  it('holds a requirement that is present without being in the order', () => {
    expect(judged(['A.esp'], 'plugins:\n  - name: A.esp\n    req: [b.esp]\n', ['A.esp', 'B.esp'])).toEqual([]);
  });

  it('breaks, at Error, a plugin whose incompatibility is present', () => {
    expect(judged(['A.esp'], 'plugins:\n  - name: A.esp\n    inc: [B.esp]\n', ['A.esp', 'B.esp'])).toEqual([{
      rule: 'incompatibility', level: 'error', plugins: [at('A.esp')], source: { file: 'masterlist', line: 2 },
      reason: '"A.esp" is incompatible with "B.esp", which is present.',
    }]);
  });

  it('breaks, at Warning, a plugin that loads before a plugin it should load after, naming both', () => {
    expect(judged(['A.esp', 'B.esp'], 'plugins:\n  - name: A.esp\n    after: [B.esp]\n')).toEqual([{
      rule: 'loadAfter', level: 'warning', plugins: [at('A.esp'), at('B.esp')], source: { file: 'masterlist', line: 2 },
      reason: '"A.esp" loads before "B.esp", and should load after it.',
    }]);
  });

  it('holds a load after that is kept, or whose plugin is not in the order', () => {
    expect([
      judged(['B.esp', 'A.esp'], 'plugins:\n  - name: A.esp\n    after: [B.esp]\n'),
      judged(['A.esp'], 'plugins:\n  - name: A.esp\n    after: [B.esp]\n'),
    ]).toEqual([[], []]);
  });

  it('shows each message at its level', () => {
    const broken = judged(['A.esp'], `plugins:
  - name: A.esp
    msg:
      - {type: error, content: e}
      - {type: warn, content: w}
      - {type: say, content: s}
`);

    expect(broken.map(({ rule, level, reason }) => [rule, level, reason])).toEqual([['message', 'error', 'e'], ['message', 'warning', 'w'], ['message', 'info', 's']]);
  });

  it('applies a regex entry to each plugin it matches', () => {
    const broken = judged(['P1.esp', 'P2.esp', 'Q.esp'], 'plugins:\n  - name: \'P\\d\\.esp\'\n    msg: [{type: say, content: hi}]\n');

    expect(broken.map(({ plugins }) => plugins[0]?.filename)).toEqual(['P1.esp', 'P2.esp']);
  });

  it('applies the entries for a plugin that are not in the order to nothing', () => {
    expect(judged(['A.esp'], 'plugins:\n  - name: Other.esp\n    msg: [{type: error, content: e}]\n')).toEqual([]);
  });

  it('merges a userlist entry over the masterlist\'s, naming the userlist line of what it states', () => {
    const broken = judged(
      ['A.esp', 'B.esp'], 'plugins:\n  - name: A.esp\n    msg: [{type: say, content: from the masterlist}]\n', ['A.esp', 'B.esp'],
      'plugins:\n  - name: A.esp\n    after: [B.esp]\n',
    );

    expect(broken.map(({ rule, source }) => [rule, source])).toEqual([['loadAfter', { file: 'userlist', line: 2 }], ['message', { file: 'masterlist', line: 2 }]]);
  });

  it('counts a requirement stated in both files once', () => {
    const broken = judged(['A.esp'], 'plugins:\n  - name: A.esp\n    req: [B.esp]\n', ['A.esp'], 'plugins:\n  - name: A.esp\n    req: [b.esp]\n');

    expect(broken).toHaveLength(1);
  });

  it('breaks, at Warning, a condition it cannot evaluate, instead of skipping what it guards', () => {
    const broken = judged(['A.esp'], `plugins:
  - name: A.esp
    req: [{name: B.esp, condition: 'active("C.esp")'}]
    msg: [{type: error, content: e, condition: 'file("D.esp")'}]
`);

    expect(broken.map(({ rule, level, reason }) => [rule, level, reason])).toEqual([
      ['condition', 'warning', '"A.esp": the condition active("C.esp") on a requirement cannot be evaluated, so "B.esp" is not checked.'],
      ['condition', 'warning', '"A.esp": the condition file("D.esp") on a message cannot be evaluated, so the message is not shown.'],
    ]);
  });

  describe('a group that loads before a group it names', () => {
    const groups = `groups:
  - name: default
  - name: early
    after: [default]
  - name: late
    after: [early]
plugins:
  - {name: E.esp, group: early}
  - {name: L.esp, group: late}
  - {name: L2.esp, group: late}
`;

    it('breaks, at Info, a plugin that loads before a plugin of a group its own loads after, naming the last of them', () => {
      expect(judged(['L.esp', 'E.esp'], groups)).toEqual([{
        rule: 'group', level: 'info', plugins: [at('L.esp'), at('E.esp')], source: { file: 'masterlist', line: 5 },
        reason: '"L.esp" is in the group "late", which loads after the group "early", and loads before "E.esp", of that group.',
      }]);
    });

    it('holds a group order that is kept', () => {
      expect(judged(['E.esp', 'L.esp'], groups)).toEqual([]);
    });

    it('names one plugin for each plugin, however many it loads before', () => {
      const broken = judged(['L.esp', 'L2.esp', 'E.esp', 'E2.esp'], `${groups}  - {name: E2.esp, group: early}\n`);

      expect(broken.map(({ plugins }) => plugins.map(({ filename }) => filename))).toEqual([['L.esp', 'E2.esp'], ['L2.esp', 'E2.esp']]);
    });

    const pairs = (broken: ReturnType<typeof judged>) => broken.map(({ plugins }) => plugins.map(({ filename }) => filename));

    it.each([
      ['names, for each plugin, the last plugin it loads before however many', ['L.esp', 'L2.esp', 'E.esp', 'E2.esp'], '  - {name: E2.esp, group: early}\n', [['L.esp', 'E2.esp'], ['L2.esp', 'E2.esp']]],
      ['follows a group\'s after through the groups between', ['L.esp', 'D.esp'], '  - {name: D.esp}\n', [['L.esp', 'D.esp']]],
      ['puts a plugin with no group in the default group', ['E.esp', 'D.esp'], '  - {name: D.esp}\n', [['E.esp', 'D.esp']]],
      ['holds a plugin whose group loads after, whatever the order of the others', ['D.esp', 'E.esp', 'L.esp'], '  - {name: D.esp}\n', []],
    ])('%s', (_, order, extra, expected) => {
      expect(pairs(judged(order, groups + extra))).toEqual(expected);
    });

    it('judges no group through the groups that load after each other, and judges the edges outside the cycle', () => {
      const cycle = `groups:
  - {name: a, after: [b]}
  - {name: b, after: [a]}
  - {name: c, after: [a]}
plugins:
  - {name: A.esp, group: a}
  - {name: B.esp, group: b}
  - {name: C.esp, group: c}
`;

      expect([pairs(judged(['A.esp', 'B.esp'], cycle)), pairs(judged(['C.esp', 'A.esp', 'B.esp'], cycle))]).toEqual([[], [['C.esp', 'A.esp']]]);
    });

    it('holds the order of groups within each of masters, blueprint masters and the rest, never across them', () => {
      const extra = ['L.esm: late', 'E.esm: early', 'LB.esm: late', 'EB.esp: early'].map((entry) => `  - {name: ${entry.split(': ')[0]}, group: ${entry.split(': ')[1]}}\n`).join('');
      const broken = judged(['L.esm', 'E.esp', 'L.esp', 'E.esm', 'LB.esm', 'EB.esp'], groups + extra, undefined, undefined, {
        'L.esm': 'masters', 'E.esm': 'masters', 'LB.esm': 'blueprintMasters',
      });

      expect(pairs(broken)).toEqual([['L.esm', 'E.esm'], ['L.esp', 'EB.esp']]);
    });

    it('takes the first entry that states a group over the entries after it', () => {
      const broken = judged(['L.esp', 'E.esp'], `groups:
  - name: default
  - {name: early, after: [default]}
  - {name: late, after: [early]}
plugins:
  - {name: L.esp, group: early}
  - {name: 'L.*', group: late}
  - {name: E.esp, group: early}
`);

      expect(broken).toEqual([]);
    });

    it('points the rule at a userlist edge on its path', () => {
      const broken = judged(['L.esp', 'D.esp'], `${groups}  - {name: D.esp}\n`, ['L.esp', 'D.esp'], 'groups:\n  - {name: early, after: [default]}\n');

      expect(broken.map(({ source }) => source)).toEqual([{ file: 'userlist', line: 1 }]);
    });

    it('breaks a group the userlist gives an after to, with no masterlist to declare default', () => {
      const broken = judged(['E.esp', 'D.esp'], '', ['E.esp', 'D.esp'], 'groups:\n  - {name: early, after: [default]}\nplugins:\n  - {name: E.esp, group: early}\n');

      expect(pairs(broken)).toEqual([['E.esp', 'D.esp']]);
    });

    it('breaks a plugin by a group the userlist gives an after', () => {
      const broken = judged(['E.esp', 'S.esp'], groups, ['E.esp', 'S.esp'], 'groups:\n  - {name: aside}\n  - {name: early, after: [aside]}\nplugins:\n  - {name: S.esp, group: aside}\n');

      expect(broken.map(({ plugins, source }) => [plugins[0]?.filename, source])).toEqual([['E.esp', { file: 'userlist', line: 2 }]]);
    });

    it('takes the group a userlist entry states over the masterlist\'s', () => {
      expect(judged(['L.esp', 'E.esp'], groups, ['L.esp', 'E.esp'], 'plugins:\n  - {name: L.esp, group: default}\n')).toEqual([]);
    });
  });
});
