import { describe, expect, it, vi } from 'vitest';
import { judge, type PluginFactsOf } from '../../sortingRules/judge';
import { landingDrop, moveOrderRefusal, offeredMoves, type ListedPlugins } from '../pluginOrder';

vi.mock('../../sortingRules/judge', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../sortingRules/judge')>();
  return { ...original, judge: vi.fn(original.judge) };
});

type Facts = NonNullable<ReturnType<PluginFactsOf>>;

const factsFrom = (table: Record<string, Partial<Facts>>): PluginFactsOf => (filename) => {
  const row = table[filename];
  return row && { origin: 'Mod', masters: [], blueprint: false, master: false, ...row };
};
const listedOf = (lines: readonly string[], { loadedWithNoLine = [], inactive = [] }: { loadedWithNoLine?: string[]; inactive?: string[] } = {}): ListedPlugins =>
  ({ loadedWithNoLine, lines, isActive: (name) => !inactive.includes(name) });
const brokenIn = ({ loadedWithNoLine, lines, isActive }: ListedPlugins, facts: PluginFactsOf) =>
  judge(loadedWithNoLine, lines.filter(isActive), facts).broken;

describe('offeredMoves: the broken rules a move keeps where a drop would land', () => {
  it('offers the master moving directly above its dependant', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esp': { masters: ['A.esp'] } });
    const listed = listedOf(['B.esp', 'A.esp']);

    const [offered, ...more] = offeredMoves(listed, brokenIn(listed, facts), facts);

    expect(more).toEqual([]);
    expect(offered?.drop).toEqual({ kind: 'before', name: 'B.esp' });
    expect(offered?.mover).toEqual({ origin: 'Mod', name: 'A.esp' });
    expect(offered?.rule.rule).toBe('master');
  });

  it('offers the plugin the game moves going where the game loads it', () => {
    const facts = factsFrom({ 'A.esp': {}, 'M.esm': { master: true } });
    const listed = listedOf(['A.esp', 'M.esm']);

    const [offered, ...more] = offeredMoves(listed, brokenIn(listed, facts), facts);

    expect(more).toEqual([]);
    expect(offered?.drop).toEqual({ kind: 'before', name: 'A.esp' });
    expect(offered?.mover).toEqual({ origin: 'Mod', name: 'M.esm' });
    expect(offered?.rule.rule).toBe('gameMoves');
  });

  it('leaves out a move that breaks another rule at Error', () => {
    const facts = factsFrom({ 'B.esp': { masters: ['A.esp'] }, 'C.esp': {}, 'A.esp': { masters: ['C.esp'] } });
    const listed = listedOf(['B.esp', 'C.esp', 'A.esp']);
    const broken = brokenIn(listed, facts);

    expect(broken.map(({ rule }) => rule)).toEqual(['master']);
    expect(offeredMoves(listed, broken, facts)).toEqual([]);
  });

  it('offers a move past a disabled line, which the game does not load', () => {
    const facts = factsFrom({ 'D.esp': { masters: ['M.esp'] }, 'X.esp': {}, 'M.esp': { masters: ['X.esp'] } });
    const listed = listedOf(['D.esp', 'X.esp', 'M.esp'], { inactive: ['X.esp'] });

    expect(offeredMoves(listed, brokenIn(listed, facts), facts).map(({ mover }) => mover.name)).toEqual(['M.esp']);
  });

  it('offers no move of or beside a plugin with no line', () => {
    const facts = factsFrom({ 'N.esp': {}, 'M.esm': { master: true } });
    const listed = listedOf(['M.esm'], { loadedWithNoLine: ['N.esp'] });

    expect(brokenIn(listed, facts).map(({ rule }) => rule)).toEqual(['gameMoves']);
    expect(offeredMoves(listed, brokenIn(listed, facts), facts)).toEqual([]);
  });

  it('offers nothing for a rule no move keeps', () => {
    const facts = factsFrom({ 'B.esp': { masters: ['A.esp'] } });
    const listed = listedOf(['B.esp']);

    expect(offeredMoves(listed, brokenIn(listed, facts), facts)).toEqual([]);
  });
});

describe('moveOrderRefusal: a drop the game would undo', () => {
  it('refuses a drop that makes the game move the plugin it drops, giving the game\'s reason', () => {
    const facts = factsFrom({ 'A.esp': {}, 'M.esm': { master: true } });
    const listed = listedOf(['M.esm', 'A.esp']);

    expect(moveOrderRefusal(listed, ['M.esm'], { kind: 'after', name: 'A.esp' }, facts)).toContain('"M.esm" loads as a master');
  });

  it('refuses a drop that makes the game move a plugin it did not drop', () => {
    const facts = factsFrom({ 'A.esp': {}, 'B.esp': {}, 'M.esm': { master: true } });
    const listed = listedOf(['M.esm', 'A.esp', 'B.esp']);

    expect(moveOrderRefusal(listed, ['B.esp'], { kind: 'before', name: 'M.esm' }, facts)).toContain('"M.esm" loads as a master');
  });

  it('lands an unrelated drop while the game already moves another plugin', () => {
    const facts = factsFrom({ 'A.esp': {}, 'M.esm': { master: true }, 'B.esp': {}, 'C.esp': {} });
    const listed = listedOf(['A.esp', 'M.esm', 'B.esp', 'C.esp']);

    expect(brokenIn(listed, facts).map(({ rule }) => rule)).toEqual(['gameMoves']);
    expect(moveOrderRefusal(listed, ['C.esp'], { kind: 'before', name: 'B.esp' }, facts)).toBeUndefined();
  });
});

describe('landingDrop: the cost of a landing', () => {
  it('judges a fixed number of times however many lines plugins.txt holds', () => {
    const plain = Array.from({ length: 500 }, (_, index) => `Plain${index}.esp`);
    const facts = factsFrom({ 'Base.esm': { master: true }, ...Object.fromEntries(plain.map((name) => [name, {}])) });
    vi.mocked(judge).mockClear();

    const drop = landingDrop(listedOf(['Base.esm', ...plain]), 'New.esm', facts, ['.esm']);

    expect(drop).toEqual({ kind: 'before', name: 'Plain0.esp' });
    expect(vi.mocked(judge)).toHaveBeenCalledTimes(3);
  });

  it('lands where the game loads the plugin when its own master is hoisted wherever it lands', () => {
    const facts = factsFrom({ 'Base.esm': { master: true }, 'Dep.esp': {}, 'Other.esp': {}, 'New.esm': { master: true, masters: ['Dep.esp'] } });

    expect(landingDrop(listedOf(['Base.esm', 'Other.esp', 'Dep.esp']), 'New.esm', facts, ['.esm'])).toEqual({ kind: 'before', name: 'Other.esp' });
  });
});
