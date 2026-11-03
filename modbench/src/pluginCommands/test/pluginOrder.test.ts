import { describe, expect, it } from 'vitest';
import { judge, type PluginFactsOf } from '../../sortingRules/judge';
import { offeredMoves } from '../pluginOrder';

type Facts = NonNullable<ReturnType<PluginFactsOf>>;

const factsFrom = (table: Record<string, Partial<Facts>>): PluginFactsOf => (filename) => {
  const row = table[filename];
  return row && { origin: 'Mod', masters: [], blueprint: false, master: false, ...row };
};

describe('offeredMoves: the broken rules a move keeps without breaking another at Error', () => {
  it('offers the master moving directly above its dependant', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esp': { masters: ['A.esp'] } });
    const order = ['B.esp', 'A.esp'];

    const [offered, ...more] = offeredMoves(order, judge(order, facts), facts);

    expect(more).toEqual([]);
    expect(offered?.drop).toEqual({ kind: 'before', name: 'B.esp' });
    expect(offered?.mover).toEqual({ origin: 'Mod', name: 'A.esp' });
    expect(offered?.rule.rule).toBe('master');
  });

  it('leaves out a move that breaks another rule at Error', () => {
    const facts = factsFrom({ 'N.esp': {}, 'M.esm': { master: true, masters: ['N.esp'] } });
    const order = ['N.esp', 'M.esm'];
    const broken = judge(order, facts);

    expect(broken.map(({ rule }) => rule)).toEqual(['masterFlag']);
    expect(offeredMoves(order, broken, facts)).toEqual([]);
  });

  it('judges the move over every line, as the write does: a disabled plugin a move would strand its master after counts', () => {
    const facts = factsFrom({ 'D.esp': { masters: ['M.esp'] }, 'X.esp': {}, 'M.esp': { masters: ['X.esp'] } });
    const active = ['D.esp', 'M.esp'];
    const lines = ['D.esp', 'X.esp', 'M.esp'];

    expect(offeredMoves(active, judge(active, facts), facts).map(({ mover }) => mover.name)).toEqual(['M.esp']);
    expect(offeredMoves(lines, judge(active, facts), facts)).toEqual([]);
  });

  it('offers no move of or beside a plugin with no line', () => {
    const facts = factsFrom({ 'N.esp': {}, 'M.esm': { master: true } });
    const active = ['N.esp', 'M.esm'];

    expect(judge(active, facts).map(({ rule }) => rule)).toEqual(['masterFlag']);
    expect(offeredMoves(['M.esm'], judge(active, facts), facts)).toEqual([]);
  });

  it('offers nothing for a rule no move keeps', () => {
    const facts = factsFrom({ 'B.esp': { masters: ['A.esp'] } });
    const order = ['B.esp'];

    expect(offeredMoves(order, judge(order, facts), facts)).toEqual([]);
  });
});
