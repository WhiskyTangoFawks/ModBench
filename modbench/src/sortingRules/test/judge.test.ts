import { describe, expect, it } from 'vitest';
import { judge, type PluginFactsOf } from '../judge';

type PluginFacts = NonNullable<ReturnType<PluginFactsOf>>;

const factsFrom = (table: Record<string, Partial<PluginFacts>>): PluginFactsOf => (filename) => {
  const row = table[filename];
  return row && { origin: 'Mod', masters: [], blueprint: false, master: false, ...row };
};
const ref = (filename: string) => ({ origin: 'Mod', filename });

describe('judge: the game\'s sorting rules held against a plugin order', () => {
  it('holds nothing broken in an order that keeps masters first and blueprint plugins last', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esp': { masters: ['A.esp'] }, 'C.esp': { blueprint: true } });

    expect(judge(['A.esp', 'B.esp', 'C.esp'], facts)).toEqual([]);
  });

  it('breaks a plugin that loads before its master, at Error, naming the master then the dependant', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esp': { masters: ['a.ESP'] } });

    expect(judge(['B.esp', 'A.esp'], facts)).toEqual([{
      rule: 'master', level: 'error', plugins: [ref('A.esp'), ref('B.esp')],
      reason: '"A.esp" is a master of "B.esp", so it must load before it.',
    }]);
  });

  it('breaks a blueprint plugin that loads before a plugin that is not one', () => {
    const facts = factsFrom({ 'A.esp': { blueprint: true }, 'B.esp': {} });

    expect(judge(['A.esp', 'B.esp'], facts)).toEqual([{
      rule: 'blueprint', level: 'error', plugins: [ref('A.esp'), ref('B.esp')],
      reason: '"A.esp" is a blueprint plugin, so it must load after "B.esp", which is not.',
    }]);
  });

  it('holds master order only within one blueprint class', () => {
    const facts = factsFrom({ 'A.esp': { blueprint: true }, 'B.esp': { masters: ['A.esp'] } });

    expect(judge(['A.esp', 'B.esp'], facts).map((broken) => broken.rule)).toEqual(['blueprint']);
  });

  it('judges no rule that needs facts mEdit has not given', () => {
    const facts = factsFrom({ 'B.esp': { masters: ['A.esp'] } });

    expect(judge(['B.esp', 'A.esp'], facts)).toEqual([]);
  });

  it('carries the origin the facts give each plugin', () => {
    const facts: PluginFactsOf = (filename) => ({ origin: `From ${filename}`, masters: filename === 'B.esp' ? ['A.esp'] : [], blueprint: false, master: false });

    expect(judge(['B.esp', 'A.esp'], facts)[0]?.plugins).toEqual([{ origin: 'From A.esp', filename: 'A.esp' }, { origin: 'From B.esp', filename: 'B.esp' }]);
  });

  it('reads a master named in another case as present', () => {
    const facts = factsFrom({ 'Base.ESM': {}, 'Patch.esp': { masters: ['base.esm'] } });

    expect(judge(['Base.ESM', 'Patch.esp'], facts)).toEqual([]);
  });

  it('judges only the masters a plugin names, not the masters of those', () => {
    const facts = factsFrom({ 'A.esm': { masters: ['Ghost.esm'] }, 'B.esp': { masters: ['A.esm'] } });

    expect(judge(['A.esm', 'B.esp'], facts).map((broken) => broken.plugins.map((plugin) => plugin.filename))).toEqual([['A.esm']]);
  });

  it('breaks, at Error, a plugin whose master is not in the order', () => {
    const facts = factsFrom({ 'B.esp': { masters: ['Ghost.esm'] } });

    expect(judge(['B.esp'], facts)).toEqual([{
      rule: 'missingMaster', level: 'error', plugins: [ref('B.esp')],
      reason: '"Ghost.esm" is a master of "B.esp", and is missing or not active.',
    }]);
  });

  it('breaks, at Warning, a plugin with the master flag listed after one without it, naming the first such plugin', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esp': {}, 'C.esm': { master: true } });

    expect(judge(['A.esp', 'B.esp', 'C.esm'], facts)).toEqual([{
      rule: 'masterFlag', level: 'warning', plugins: [ref('C.esm'), ref('A.esp')],
      reason: '"C.esm" has the master flag, so the game loads it before "A.esp", which has not.',
    }]);
  });

  it('gives each plugin with the master flag its own entry', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esm': { master: true }, 'C.esm': { master: true } });

    expect(judge(['A.esp', 'B.esm', 'C.esm'], facts).map((broken) => broken.plugins.map((plugin) => plugin.filename)))
      .toEqual([['B.esm', 'A.esp'], ['C.esm', 'A.esp']]);
  });

  it('holds a plugin with the master flag listed before one without it', () => {
    const facts = factsFrom({ 'A.esm': { master: true }, 'B.esp': {} });

    expect(judge(['A.esm', 'B.esp'], facts)).toEqual([]);
  });
});
