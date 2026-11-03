import { describe, expect, it } from 'vitest';
import type { ConditionFacts, FileRead } from '../lootConditions';
import { judgeLoot, readsNamed, type LootPartition } from '../lootJudge';
import { rulesReader, type SortingRuleFiles } from '../lootMetadata';

const readRules = (files: SortingRuleFiles) => rulesReader()(files);
type SortingRuleFile = SortingRuleFiles['masterlist'];
const text = (body: string): SortingRuleFile => ({ path: '/instance/f.yaml', kind: 'text', text: body });
const ABSENT: SortingRuleFile = { path: '/instance/f.yaml', kind: 'absent' };
const rules = (parts: Partial<SortingRuleFiles>) => readRules({ masterlist: ABSENT, prelude: ABSENT, userlist: ABSENT, ...parts });
const at = (filename: string) => ({ origin: 'Mod', filename });

interface World {
  present?: string[];
  active?: string[];
  answers?: Record<string, string | number | boolean | undefined | Error>;
}

const factsOf = ({ present = [], active = [], answers = {} }: World): ConditionFacts => ({
  files: () => ({ names: present, complete: true }),
  isPresent: (path) => (present.some((name) => name.toLowerCase() === path.toLowerCase()) ? 'present' : 'absent'),
  activePlugins: () => active,
  isMaster: () => false,
  description: () => undefined,
  answer: ({ kind, path }: FileRead) => {
    const answer = answers[`${kind}:${path}`];
    return answer instanceof Error ? { kind: 'unreadable', why: answer.message } : { kind: 'read', value: answer };
  },
});

const judgedIn = (world: World, order: string[], masterlist: string, userlist?: string, partitions: Record<string, LootPartition> = {}) =>
  judgeLoot(order.map(at), {
    ...rules({ masterlist: text(masterlist), ...userlist === undefined ? {} : { userlist: text(userlist) } }),
    facts: factsOf(world),
  }, (filename) => partitions[filename] ?? 'nonMasters');

const judged = (order: string[], masterlist: string, present: string[] = order, userlist?: string, partitions: Record<string, LootPartition> = {}) =>
  judgedIn({ present, active: order }, order, masterlist, userlist, partitions);

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
    expect(judged(['A.esp', 'B.esp'], 'plugins:\n  - name: A.esp\n    inc: [B.esp]\n')).toEqual([{
      rule: 'incompatibility', level: 'error', plugins: [at('A.esp')], source: { file: 'masterlist', line: 2 },
      reason: '"A.esp" is incompatible with "B.esp", which is present.',
    }]);
  });

  it('counts an incompatible plugin present only while it is active, and any other file while it is present', () => {
    const masterlist = 'plugins:\n  - name: A.esp\n    inc: [B.esp, C.dll]\n';

    expect(judgedIn({ present: ['A.esp', 'B.esp', 'C.dll'], active: ['A.esp'] }, ['A.esp'], masterlist).map(({ reason }) => reason))
      .toEqual(['"A.esp" is incompatible with "C.dll", which is present.']);
  });

  it('counts a regular expression incompatibility present while a plugin it matches is active', () => {
    const masterlist = "plugins:\n  - name: A.esp\n    inc: ['B.*\\.esp']\n";
    const reasons = (active: string[]) => judgedIn({ present: ['A.esp', 'Bx.esp'], active }, ['A.esp'], masterlist).map(({ reason }) => reason);

    expect([reasons(['A.esp', 'Bx.esp']), reasons(['A.esp'])]).toEqual([['"A.esp" is incompatible with "B.*\\.esp", which is present.'], []]);
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

  it('leaves out what a false condition guards, and applies what a true one guards', () => {
    const masterlist = `plugins:
  - name: A.esp
    req: [{name: B.esp, condition: 'active("C.esp")'}]
    msg: [{type: error, content: e, condition: 'not active("C.esp")'}]
`;

    expect([
      judgedIn({ active: ['A.esp', 'C.esp'] }, ['A.esp'], masterlist).map(({ rule }) => rule),
      judgedIn({ active: ['A.esp'] }, ['A.esp'], masterlist).map(({ rule }) => rule),
    ]).toEqual([['requirement'], ['message']]);
  });

  it('breaks, at Warning, a condition it cannot evaluate, saying why, instead of skipping what it guards', () => {
    const broken = judged(['A.esp'], `plugins:
  - name: A.esp
    req: [{name: B.esp, condition: 'frobnicate("C.esp")'}]
`);
    const unreadable = judgedIn(
      { answers: { 'checksum:D.esp': new Error('permission denied') } }, ['A.esp'],
      `plugins:\n  - name: A.esp\n    after: [{name: B.esp, condition: 'checksum("D.esp", 1)'}]\n`,
    );

    expect(broken.map(({ rule, level, reason }) => [rule, level, reason])).toEqual([
      ['condition', 'warning', '"A.esp": the condition frobnicate("C.esp") on a requirement cannot be evaluated (frobnicate() is not a function Modbench evaluates), so "B.esp" is not checked.'],
    ]);
    expect(unreadable.map(({ reason }) => reason)).toEqual(['"A.esp": the condition checksum("D.esp", 1) on a load after cannot be evaluated (permission denied), so "B.esp" is not checked.']);
  });

  it('breaks, at Warning, a requirement whose presence the instance cannot tell, instead of reading it as missing', () => {
    const broken = judgeLoot([at('A.esp')], {
      ...rules({ masterlist: text('plugins:\n  - name: A.esp\n    req: [B.esp]\n') }),
      facts: { ...factsOf({}), isPresent: () => 'unknown' },
    }, () => 'nonMasters');

    expect(broken.map(({ rule, level, reason }) => [rule, level, reason])).toEqual([
      ['condition', 'warning', '"A.esp": a requirement cannot be evaluated (the game\'s Data folder cannot be listed), so "B.esp" is not checked.'],
    ]);
  });

  describe('LOOT\'s cleaning data', () => {
    const dirty = (extra: string) => `plugins:\n  - name: A.esp\n    dirty:\n      - {crc: 0x1000, util: 'FO4Edit v4'${extra}}\n`;
    const crcOf = (crc: number) => ({ answers: { 'checksum:A.esp': crc } });

    it('says at Info that a plugin whose checksum is listed dirty is, in LOOT\'s words', () => {
      expect(judgedIn(crcOf(0x1000), ['A.esp'], dirty(", itm: 51, udr: 38, nav: 1, detail: 'Clean it.'"))).toEqual([{
        rule: 'cleaning', level: 'info', plugins: [at('A.esp')], source: { file: 'masterlist', line: 3 },
        reason: 'FO4Edit v4 found 51 ITM records, 38 deleted references and 1 deleted navmesh. Clean it.',
      }]);
    });

    it.each([
      ['no counts', '', 'FO4Edit v4 found dirty edits.'],
      ['one count', ', udr: 1', 'FO4Edit v4 found 1 deleted reference.'],
      ['two counts', ', itm: 2, nav: 3', 'FO4Edit v4 found 2 ITM records and 3 deleted navmeshes.'],
    ])('words %s', (_, counts, text) => {
      expect(judgedIn(crcOf(0x1000), ['A.esp'], dirty(counts))[0]?.reason).toBe(text);
    });

    it('holds a plugin whose checksum is not listed, or whose file is absent', () => {
      expect([judgedIn(crcOf(0x2000), ['A.esp'], dirty('')), judgedIn({}, ['A.esp'], dirty(''))]).toEqual([[], []]);
    });

    it('holds cleaning data whose condition is false', () => {
      expect(judgedIn(crcOf(0x1000), ['A.esp'], dirty(', condition: \'active("B.esp")\''))).toEqual([]);
    });

    it('breaks, at Warning, when the plugin\'s checksum cannot be read, saying the cleaning data is not checked', () => {
      const broken = judgedIn({ answers: { 'checksum:A.esp': new Error('permission denied') } }, ['A.esp'], dirty(''));

      expect(broken.map(({ rule, level, reason }) => [rule, level, reason])).toEqual([
        ['condition', 'warning', '"A.esp": its checksum cannot be read (permission denied), so its cleaning data is not checked.'],
      ]);
    });
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

    it('takes the entry that names the plugin over an entry that is a regular expression, wherever the regular expression sits', () => {
      const broken = judged(['L.esp', 'E.esp'], `groups:
  - name: default
  - {name: early, after: [default]}
  - {name: late, after: [early]}
plugins:
  - {name: 'L.*', group: late}
  - {name: L.esp, group: early}
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

describe('readsNamed: the file reads the conditions of the plugins in the order need', () => {
  const entries = rules({ masterlist: text(`plugins:
  - name: A.esp
    req: [{name: X.esp, condition: 'readable("../G.exe") and version("../G.exe", >=, "1")'}]
    msg: [{type: say, content: m, condition: 'checksum("a.swf", 1)'}]
    dirty: [{crc: 0x1, util: u, condition: 'readable("../G.exe")'}]
  - name: Other.esp
    msg: [{type: say, content: m, condition: 'checksum("other.swf", 1)'}]
`) }).entries;

  it('names each read of a condition on a rule of a plugin in the order once, and the checksum of a plugin with cleaning data', () => {
    expect(readsNamed([at('A.esp')], entries)).toEqual([
      { kind: 'readable', path: '../G.exe' },
      { kind: 'version', path: '../G.exe' },
      { kind: 'checksum', path: 'a.swf' },
      { kind: 'checksum', path: 'A.esp' },
    ]);
  });

  it('names none for the rules of a plugin outside the order', () => {
    expect(readsNamed([at('B.esp')], entries)).toEqual([]);
  });
});
