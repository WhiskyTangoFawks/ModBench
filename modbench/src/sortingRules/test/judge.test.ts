import { describe, expect, it } from 'vitest';
import { judge, type PluginFactsOf } from '../judge';

type PluginFacts = NonNullable<ReturnType<PluginFactsOf>>;

const factsFrom = (table: Record<string, Partial<PluginFacts>>): PluginFactsOf => (filename) => {
  const row = table[filename];
  return row && { origin: 'Mod', masters: [], blueprint: false, master: false, ...row };
};
const ref = (filename: string) => ({ origin: 'Mod', filename });
const MASTER = { master: true };
const BLUEPRINT = { master: true, blueprint: true };
const rulesOf = (judged: ReturnType<typeof judge>) => judged.broken.map(({ rule }) => rule);

describe('judge: the game\'s sorting rules held against the order the game loads from plugins.txt', () => {
  it('loads as listed, and holds nothing broken, an order that keeps masters first and blueprint plugins last', () => {
    const facts = factsFrom({ 'A.esm': MASTER, 'B.esp': { masters: ['A.esm'] }, 'C.esm': BLUEPRINT });

    expect(judge([], ['A.esm', 'B.esp', 'C.esm'], facts)).toEqual({ order: ['A.esm', 'B.esp', 'C.esm'], broken: [] });
  });

  it('breaks a plugin that loads before its master, at Error, naming the master then the dependant', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esp': { masters: ['a.ESP'] } });

    expect(judge([], ['B.esp', 'A.esp'], facts).broken).toEqual([{
      rule: 'master', level: 'error', plugins: [ref('A.esp'), ref('B.esp')],
      reason: '"A.esp" is a master of "B.esp", so it must load before it.',
    }]);
  });

  it('moves a plugin that loads as a master above the plugins listed before it that do not, a Warning on it alone, beside the first of them', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esp': {}, 'C.esm': MASTER });

    expect(judge([], ['A.esp', 'B.esp', 'C.esm'], facts)).toEqual({
      order: ['C.esm', 'A.esp', 'B.esp'],
      broken: [{
        rule: 'gameMoves', level: 'warning', plugins: [ref('C.esm')], placement: { side: 'before', anchor: ref('A.esp') },
        reason: '"C.esm" loads as a master, by its master flag or its extension, so the game loads it before "A.esp", not where plugins.txt lists it.',
      }],
    });
  });

  it('gives each plugin the game moves its own Warning', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esm': MASTER, 'C.esm': MASTER });

    expect(judge([], ['A.esp', 'B.esm', 'C.esm'], facts).broken.map(({ plugins }) => plugins.map(({ filename }) => filename))).toEqual([['B.esm'], ['C.esm']]);
  });

  it('hoists a master above a master that lists it, a Warning in place of the master Error', () => {
    const facts = factsFrom({ 'D.esm': { master: true, masters: ['M.esm'] }, 'M.esm': MASTER });

    expect(judge([], ['D.esm', 'M.esm'], facts)).toEqual({
      order: ['M.esm', 'D.esm'],
      broken: [{
        rule: 'gameMoves', level: 'warning', plugins: [ref('M.esm')], placement: { side: 'before', anchor: ref('D.esm') },
        reason: '"M.esm" is a master of "D.esm", which loads as a master, so the game loads it before "D.esm", not where plugins.txt lists it.',
      }],
    });
  });

  it('hoists a plugin that is not a master above a master that lists it', () => {
    const facts = factsFrom({ 'D.esm': { master: true, masters: ['M.esp'] }, 'M.esp': {} });

    expect(judge([], ['D.esm', 'M.esp'], facts)).toMatchObject({ order: ['M.esp', 'D.esm'], broken: [{ rule: 'gameMoves', plugins: [ref('M.esp')] }] });
  });

  it('hoists the masters of a hoisted master above it in turn', () => {
    const facts = factsFrom({ 'D.esm': { master: true, masters: ['M.esm'] }, 'M.esm': { master: true, masters: ['N.esm'] }, 'N.esm': MASTER });

    expect(judge([], ['D.esm', 'M.esm', 'N.esm'], facts).order).toEqual(['N.esm', 'M.esm', 'D.esm']);
  });

  it('hoists a plugin two masters list above the first of them', () => {
    const facts = factsFrom({ 'A.esm': { master: true, masters: ['N.esp'] }, 'B.esm': { master: true, masters: ['N.esp'] }, 'N.esp': {} });

    expect(judge([], ['A.esm', 'B.esm', 'N.esp'], facts).order).toEqual(['N.esp', 'A.esm', 'B.esm']);
  });

  it('warns of nothing where the game\'s moves land every plugin where plugins.txt lists it', () => {
    const facts = factsFrom({ 'N.esp': {}, 'A.esm': { master: true, masters: ['N.esp'] }, 'B.esm': { master: true, masters: ['N.esp'] } });

    expect(judge([], ['N.esp', 'A.esm', 'B.esm'], facts)).toEqual({ order: ['N.esp', 'A.esm', 'B.esm'], broken: [] });
  });

  it('moves a blueprint plugin below the plugins listed after it that are not one, beside the last of them', () => {
    const facts = factsFrom({ 'B.esm': BLUEPRINT, 'X.esp': {}, 'Y.esp': {} });

    expect(judge([], ['B.esm', 'X.esp', 'Y.esp'], facts)).toEqual({
      order: ['X.esp', 'Y.esp', 'B.esm'],
      broken: [{
        rule: 'gameMoves', level: 'warning', plugins: [ref('B.esm')], placement: { side: 'after', anchor: ref('Y.esp') },
        reason: '"B.esm" is a blueprint plugin, so the game loads it after "Y.esp", not where plugins.txt lists it.',
      }],
    });
  });

  it('loads a blueprint plugin that is not a master where it is listed, as the game moves only a blueprint master', () => {
    const facts = factsFrom({ 'B.esp': { blueprint: true }, 'X.esp': {} });

    expect(judge([], ['B.esp', 'X.esp'], facts)).toEqual({ order: ['B.esp', 'X.esp'], broken: [] });
  });

  it('hoists no blueprint plugin above a plugin that is not one, and holds that plugin to no master rule against it', () => {
    const facts = factsFrom({ 'B.esm': BLUEPRINT, 'X.esm': { master: true, masters: ['B.esm'] } });

    expect(judge([], ['B.esm', 'X.esm'], facts)).toMatchObject({ order: ['X.esm', 'B.esm'], broken: [{ rule: 'gameMoves', plugins: [ref('B.esm')] }] });
  });

  it('hoists a blueprint plugin above a blueprint plugin that lists it', () => {
    const facts = factsFrom({ 'S.esm': { ...BLUEPRINT, masters: ['B.esm'] }, 'B.esm': BLUEPRINT });

    expect(judge([], ['S.esm', 'B.esm'], facts)).toMatchObject({ order: ['B.esm', 'S.esm'], broken: [{ rule: 'gameMoves', plugins: [ref('B.esm')] }] });
  });

  it('judges no rule that needs facts mEdit has not given', () => {
    const facts = factsFrom({ 'B.esp': { masters: ['A.esp'] } });

    expect(judge([], ['B.esp', 'A.esp'], facts).broken).toEqual([]);
  });

  it('warns of no master moved above only plugins mEdit has not read', () => {
    const facts = factsFrom({ 'C.esm': MASTER });

    expect(judge([], ['U.esp', 'C.esm'], facts).broken).toEqual([]);
  });

  it('carries the origin the facts give each plugin', () => {
    const facts: PluginFactsOf = (filename) => ({ origin: `From ${filename}`, masters: filename === 'B.esp' ? ['A.esp'] : [], blueprint: false, master: false });

    expect(judge([], ['B.esp', 'A.esp'], facts).broken[0]?.plugins).toEqual([{ origin: 'From A.esp', filename: 'A.esp' }, { origin: 'From B.esp', filename: 'B.esp' }]);
  });

  it('reads a master named in another case as present', () => {
    const facts = factsFrom({ 'Base.ESM': MASTER, 'Patch.esp': { masters: ['base.esm'] } });

    expect(judge([], ['Base.ESM', 'Patch.esp'], facts).broken).toEqual([]);
  });

  it('judges only the masters a plugin names, not the masters of those', () => {
    const facts = factsFrom({ 'A.esm': { masters: ['Ghost.esm'] }, 'B.esp': { masters: ['A.esm'] } });

    expect(judge([], ['A.esm', 'B.esp'], facts).broken.map((broken) => broken.plugins.map((plugin) => plugin.filename))).toEqual([['A.esm']]);
  });

  it('breaks, at Error, a plugin whose master is not in the order', () => {
    const facts = factsFrom({ 'B.esp': { masters: ['Ghost.esm'] } });

    expect(judge([], ['B.esp'], facts).broken).toEqual([{
      rule: 'missingMaster', level: 'error', plugins: [ref('B.esp')],
      reason: '"Ghost.esm" is a master of "B.esp", and is missing or not active.',
    }]);
  });

  it('loads the plugins the game loads with no line first', () => {
    const facts = factsFrom({ 'Game.esm': MASTER, 'Creation.esl': MASTER, 'A.esm': MASTER, 'B.esp': {} });

    expect(judge(['Game.esm', 'Creation.esl'], ['A.esm', 'B.esp'], facts)).toEqual({ order: ['Game.esm', 'Creation.esl', 'A.esm', 'B.esp'], broken: [] });
  });

  it('loads a blueprint plugin with no line after the plugins that are not one, and before a blueprint line', () => {
    const facts = factsFrom({ 'Blueprint.esm': BLUEPRINT, 'A.esp': {}, 'Ship.esm': { ...BLUEPRINT, masters: ['Blueprint.esm'] } });

    expect(judge(['Blueprint.esm'], ['A.esp', 'Ship.esm'], facts)).toEqual({ order: ['A.esp', 'Blueprint.esm', 'Ship.esm'], broken: [] });
  });

  it('hoists a line above a plugin the game loads with no line that lists it, a Warning in place of the master Error', () => {
    const facts = factsFrom({ 'Creation.esm': { master: true, masters: ['Mod.esm'] }, 'Mod.esm': MASTER });

    const judged = judge(['Creation.esm'], ['Mod.esm'], facts);

    expect(judged.order).toEqual(['Mod.esm', 'Creation.esm']);
    expect(rulesOf(judged)).toEqual(['gameMoves']);
  });
});
