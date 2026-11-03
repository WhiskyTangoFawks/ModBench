import { describe, expect, it } from 'vitest';
import { evaluateCondition, readFileFacts, readsOf, Unevaluable, type ConditionFacts, type FileRead } from '../lootConditions';

interface World {
  files?: string[];
  active?: string[];
  masters?: Record<string, boolean>;
  descriptions?: Record<string, string>;
  answers?: Record<string, string | number | boolean | undefined | Error>;
}

const keyOf = ({ kind, path }: FileRead): string => `${kind}:${path}`;

function factsOf(world: World): ConditionFacts {
  const files = world.files ?? [];
  return {
    files: () => files,
    isPresent: (path) => files.some((file) => file.toLowerCase() === path.toLowerCase()),
    activePlugins: () => world.active ?? [],
    isMaster: (plugin) => world.masters?.[plugin],
    description: (plugin) => world.descriptions?.[plugin],
    answer: (read) => {
      const answer = world.answers?.[keyOf(read)];
      if (answer instanceof Error) throw new Unevaluable(answer.message);
      return answer;
    },
  };
}

const holds = (condition: string, world: World = {}) => evaluateCondition(condition, factsOf(world));
const value = (condition: string, world: World = {}) => {
  const result = holds(condition, world);
  return result.kind === 'value' ? result.value : result;
};

describe('evaluateCondition: the grammar', () => {
  it('reads and, or and not with C-style precedence and parentheses', () => {
    const world = { active: ['a.esp'] };
    expect([
      value('active("a.esp") and active("b.esp") or not active("b.esp")', world),
      value('active("a.esp") and (active("b.esp") or not active("a.esp"))', world),
      value('not (active("b.esp") or active("a.esp"))', world),
    ]).toEqual([true, false, false]);
  });

  it('does not evaluate the right of an and whose left is false, so a guard keeps an unreadable file from erroring', () => {
    const world = { answers: { 'readable:../Game.exe': false, 'version:../Game.exe': new Error('unreadable') } };

    expect(value('readable("../Game.exe") and version("../Game.exe", >=, "1.0")', world)).toBe(false);
  });

  it.each([
    ['an unknown function', 'frobnicate("a")', 'frobnicate'],
    ['a condition that does not parse', 'active("a.esp" and', 'parse'],
    ['a trailing word', 'active("a.esp") nonsense', 'parse'],
  ])('says %s cannot be evaluated', (_, condition, mention) => {
    const result = holds(condition);

    expect(result.kind).toBe('unevaluable');
    expect(result.kind === 'unevaluable' && result.reason.toLowerCase()).toContain(mention);
  });
});

describe('evaluateCondition: the functions', () => {
  it('reads file() of a path as the Data folder holding it, case-folded', () => {
    expect([value('file("Meshes/A.nif")', { files: ['meshes/a.nif'] }), value('file("B.nif")', { files: ['a.nif'] })]).toEqual([true, false]);
  });

  it('says file() cannot be evaluated when the instance cannot say whether the file is present', () => {
    const facts = { ...factsOf({}), isPresent: () => undefined };

    expect(evaluateCondition('file("A.esp") or active("A.esp")', facts)).toEqual({
      kind: 'unevaluable', reason: 'the instance cannot say whether "A.esp" is present',
    });
  });

  it('reads a regular expression in the filename of file() and many() over the folder named', () => {
    const world = { files: ['F4SE/Plugins/a.dll', 'F4SE/Plugins/b.dll', 'F4SE/Other/c.dll', 'x.esp'] };
    expect([
      value('file("F4SE/Plugins/([^\\.]+\\.dll)")', world),
      value('many("F4SE/Plugins/.*\\.dll")', world),
      value('many("F4SE/Other/.*\\.dll")', world),
      value('file("F4SE/Missing/.*\\.dll")', world),
    ]).toEqual([true, true, false, false]);
  });

  it('reads active() and many_active() of a plugin name or a pattern', () => {
    const world = { active: ['A.esp', 'B.esl', 'Other.esp'] };
    expect([
      value('active("a.esp")', world),
      value('active("c.esp")', world),
      value('active("B\\.es(l|p)")', world),
      value('many_active("[AB]\\.es(l|p)")', world),
      value('many_active("A\\.es(l|p)")', world),
    ]).toEqual([true, false, true, true, false]);
  });

  it('reads is_master() as false for an absent file and as mEdit\'s master flag for a present one', () => {
    const world = { files: ['M.esm', 'P.esp'], masters: { 'M.esm': true, 'P.esp': false } };
    expect([value('is_master("M.esm")', world), value('is_master("P.esp")', world), value('is_master("Gone.esm")', world)]).toEqual([true, false, false]);
  });

  it('says is_master() cannot be evaluated for a present plugin mEdit has not read', () => {
    expect(value('is_master("M.esm")', { files: ['M.esm'] })).toMatchObject({ kind: 'unevaluable' });
  });

  it('reads checksum() as the file\'s CRC-32, false for an absent file', () => {
    const world = { answers: { 'checksum:A.esp': 0x6ffe25b7, 'checksum:Gone.esp': undefined } };
    expect([value('checksum("A.esp", 6FFE25B7)', world), value('checksum("A.esp", 00000001)', world), value('checksum("Gone.esp", 6FFE25B7)', world)])
      .toEqual([true, false, false]);
  });

  it('reads readable() as the Instance adapter answers', () => {
    expect([value('readable("../G.exe")', { answers: { 'readable:../G.exe': true } }), value('readable("../G.exe")', { answers: { 'readable:../G.exe': false } })])
      .toEqual([true, false]);
  });

  it('reads version() of a plugin from its description', () => {
    const world = { files: ['P.esp'], descriptions: { 'P.esp': 'Patch v2.0.5' } };
    expect([value('version("P.esp", >=, "2.0.2")', world), value('version("P.esp", <, "2.0.5")', world), value('version("P.esp", ==, "2.0.5.0")', world)])
      .toEqual([true, false, true]);
  });

  it('reads version() of a plugin without a version, or an absent one, as false', () => {
    const world = { files: ['P.esp'], descriptions: { 'P.esp': 'No number' } };
    expect([value('version("P.esp", >=, "1")', world), value('version("Gone.esp", !=, "1")', world)]).toEqual([false, false]);
  });

  it('says version() of a present plugin mEdit has not read cannot be evaluated', () => {
    expect(value('version("P.esp", >=, "1")', { files: ['P.esp'] })).toMatchObject({ kind: 'unevaluable' });
  });

  it('reads version() and product_version() of an executable as the Instance adapter answers', () => {
    const world = { answers: { 'version:../G.exe': '1.10.163.0', 'productVersion:../G.exe': '1.5', 'version:../Gone.exe': undefined } };
    expect([
      value('version("../G.exe", >=, "1.10.163.0")', world),
      value('version("../G.exe", !=, "1.10.163.0")', world),
      value('product_version("../G.exe", <, "1.6")', world),
      value('version("../Gone.exe", !=, "1")', world),
    ]).toEqual([true, false, true, false]);
  });

  it('says a read that failed cannot be evaluated, with why', () => {
    expect(value('checksum("A.esp", 1)', { answers: { 'checksum:A.esp': new Error('permission denied') } }))
      .toEqual({ kind: 'unevaluable', reason: 'permission denied' });
  });
});

describe('readFileFacts: the Instance adapter\'s answers to the reads a condition needs', () => {
  const source = {
    checksum: async (path: string) => (path === 'locked.swf' ? Promise.reject(new Error('permission denied')) : path === 'a.swf' ? 0xabc : undefined),
    version: async (path: string, field: 'file' | 'product') => (path === '../G.exe' ? `${field} 1.2` : undefined),
    readable: async (path: string) => path === '../G.exe',
  };
  const instance = { files: () => [], isPresent: () => false };

  it('evaluates a condition over what was read', async () => {
    const reads: FileRead[] = [
      { kind: 'checksum', path: 'a.swf' }, { kind: 'version', path: '../G.exe' }, { kind: 'productVersion', path: '../G.exe' }, { kind: 'readable', path: '../G.exe' },
    ];
    const facts = await readFileFacts(reads, source, instance);

    expect(facts.answer({ kind: 'checksum', path: 'a.swf' })).toBe(0xabc);
    expect(facts.answer({ kind: 'productVersion', path: '../G.exe' })).toBe('product 1.2');
    expect(facts.answer({ kind: 'readable', path: '../G.exe' })).toBe(true);
  });

  it('says a read that failed, with why, and a read nobody asked for, cannot be evaluated', async () => {
    const facts = await readFileFacts([{ kind: 'checksum', path: 'locked.swf' }], source, instance);

    expect(() => facts.answer({ kind: 'checksum', path: 'locked.swf' })).toThrow('the checksum of "locked.swf" could not be read: permission denied');
    expect(() => facts.answer({ kind: 'checksum', path: 'other.swf' })).toThrow('was not read');
  });
});

describe('readsOf: the file reads a condition needs', () => {
  it('names each, once, and none for a condition that does not parse', () => {
    expect(readsOf('readable("../G.exe") and version("../G.exe", >=, "1") and checksum("a.swf", 1) and checksum("a.swf", 2) and product_version("x.dll", <, "2")'))
      .toEqual([
        { kind: 'readable', path: '../G.exe' },
        { kind: 'version', path: '../G.exe' },
        { kind: 'checksum', path: 'a.swf' },
        { kind: 'productVersion', path: 'x.dll' },
      ]);
    expect(readsOf('active(')).toEqual([]);
  });

  it('names no file read for what mEdit or the instance value answers', () => {
    expect(readsOf('active("a.esp") and file("b.nif") and is_master("c.esm") and version("d.esp", >=, "1") and many("e.*")')).toEqual([]);
  });

});
