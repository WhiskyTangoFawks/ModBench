import { describe, expect, it } from 'vitest';
import { addNamed, type PluginRecords } from '../namedPlugins';

const A = { name: 'A.esp', origin: 'ModA' };
const B = { name: 'B.esp', origin: 'ModB' };

const named = (...asked: PluginRecords[]) => {
  const into = new Map<string, PluginRecords>();
  for (const each of asked) addNamed(into, each);
  return [...into.values()];
};

describe('the plugins and records a change names', () => {
  it('combines the records two changes name of one plugin', () => {
    expect(named({ plugin: A, keys: ['1'] }, { plugin: A, keys: ['1', '2'] })).toEqual([{ plugin: A, keys: ['1', '2'] }]);
  });

  it.each([
    ['first', [{ plugin: A }, { plugin: A, keys: ['1'] }]],
    ['last', [{ plugin: A, keys: ['1'] }, { plugin: A }]],
    ['with no records', [{ plugin: A, keys: ['1'] }, { plugin: A, keys: [] }]],
  ])('asks the whole plugin when a change names it whole, %s', (_when, changes) => {
    expect(named(...changes)).toEqual([{ plugin: A, keys: undefined }]);
  });

  it('keeps each plugin apart', () => {
    expect(named({ plugin: A, keys: ['1'] }, { plugin: B, keys: ['2'] })).toEqual([{ plugin: A, keys: ['1'] }, { plugin: B, keys: ['2'] }]);
  });
});
