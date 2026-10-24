import { describe, expect, it } from 'vitest';
import { pluginOrderOf } from '../pluginOrder';

interface Row { name: string; origin: string; line: number | null; enabled: boolean; winning: boolean }
const row = (name: string, origin: string, line: number | null, enabled = true, winning = true): Row => ({ name, origin, line, enabled, winning });
const absent = ({ name, origin }: { name: string; origin: string }): Row => row(name, origin, null);
const orderOf = (plugins: Row[], noLine: { name: string; origin: string }[]) =>
  pluginOrderOf({ plugins, pluginsLoadedWithNoLine: noLine }, absent);

describe('the plugin order: the plugins the game loads with no line, then the lines', () => {
  it('places the plugins the game loads with no line before every line, and the lines by line number', () => {
    const { loadedWithNoLine, fromLines } = orderOf([row('B.esp', 'Mod', 1), row('A.esp', 'Mod', 0)], [{ name: 'Fallout4.esm', origin: 'Data/' }]);

    expect([...loadedWithNoLine, ...fromLines].map((p) => p.name)).toEqual(['Fallout4.esm', 'A.esp', 'B.esp']);
  });

  it('leaves an overridden plugin out, for its winner stands for the line', () => {
    const { fromLines } = orderOf([row('A.esp', 'Low', 0, true, false), row('A.esp', 'High', 0)], []);

    expect(fromLines.map((p) => p.origin)).toEqual(['High']);
  });

  it('hands back an overridden copy and a plugin no line names as others, and never a plugin it placed', () => {
    const overridden = row('A.esp', 'Low', 0, true, false);
    const unlined = row('C.esp', 'Mod', null, false);
    const { others } = orderOf([overridden, row('A.esp', 'High', 0), unlined, row('Fallout4.esm', 'Data/', 1)], [{ name: 'Fallout4.esm', origin: 'Data/' }]);

    expect(others).toEqual([overridden, unlined]);
  });

  it('answers the plugin row a mod provides for one the game loads with no line, and no second row for it', () => {
    const provided = row('Fallout4.esm', 'Mod', null, false);
    const { loadedWithNoLine, fromLines, others } = orderOf([provided], [{ name: 'Fallout4.esm', origin: 'Mod' }]);

    expect({ loadedWithNoLine, fromLines, others }).toEqual({ loadedWithNoLine: [provided], fromLines: [], others: [] });
  });

  it('drops a line that names a Data folder master, whatever its case', () => {
    const { loadedWithNoLine, fromLines } = orderOf([row('fallout4.esm', 'Data/', 0)], [{ name: 'Fallout4.esm', origin: 'Data/' }]);

    expect({ loadedWithNoLine: loadedWithNoLine.map((p) => p.name), fromLines }).toEqual({ loadedWithNoLine: ['Fallout4.esm'], fromLines: [] });
  });
});
