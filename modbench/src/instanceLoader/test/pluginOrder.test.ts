import { describe, expect, it } from 'vitest';
import { activeInGameOrder, inGameOrder, pluginOrderOf } from '../pluginOrder';

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

describe('the game\'s order, where the release loads a blueprint plugin after every plugin that is not one', () => {
  const at = (name: string) => ({ name, origin: 'Mod' });
  const blueprints = (...names: string[]) => (p: { name: string }) => names.includes(p.name);
  const orderOfNames = (noLine: string[], lines: string[], isBlueprint: (p: { name: string }) => boolean, blueprintLoadsLast = true) =>
    inGameOrder(noLine.map(at), lines.map(at), isBlueprint, blueprintLoadsLast).map((p) => p.name);

  it('places a blueprint plugin with no line after the last line that is not a blueprint plugin, and before a blueprint line', () => {
    expect(orderOfNames(['Base.esm', 'Blueprint.esm'], ['A.esp', 'B.esp', 'Ship.esm'], blueprints('Blueprint.esm', 'Ship.esm')))
      .toEqual(['Base.esm', 'A.esp', 'B.esp', 'Blueprint.esm', 'Ship.esm']);
  });

  it('leaves the order as it is when no plugin is a blueprint plugin', () => {
    expect(orderOfNames(['Base.esm'], ['A.esp', 'B.esp'], blueprints())).toEqual(['Base.esm', 'A.esp', 'B.esp']);
  });

  it('places a blueprint plugin with no line first when every line is a blueprint plugin', () => {
    expect(orderOfNames(['Blueprint.esm'], ['Ship.esm'], blueprints('Blueprint.esm', 'Ship.esm'))).toEqual(['Blueprint.esm', 'Ship.esm']);
  });

  it('places the plugins with no line before every line in a release that does not', () => {
    expect(orderOfNames(['Base.esm', 'Blueprint.esm'], ['A.esp', 'B.esp', 'Ship.esm'], blueprints('Blueprint.esm', 'Ship.esm'), false))
      .toEqual(['Base.esm', 'Blueprint.esm', 'A.esp', 'B.esp', 'Ship.esm']);
  });
});

describe('the snapshot\'s active plugins in the game\'s order', () => {
  const at = (name: string) => ({ name, origin: 'Mod' });
  const snapshot = { loadedWithNoLine: ['Base.esm', 'Blueprint.esm'].map(at), active: ['Base.esm', 'Blueprint.esm', 'A.esp', 'B.esp'].map(at) };

  it('takes the lines to be what follows the plugins the game loads with no line', () => {
    expect(activeInGameOrder(snapshot, (p) => p.name === 'Blueprint.esm', true).map((p) => p.name)).toEqual(['Base.esm', 'A.esp', 'B.esp', 'Blueprint.esm']);
  });

  it('keeps the snapshot\'s order in a release that loads no blueprint plugin last', () => {
    expect(activeInGameOrder(snapshot, (p) => p.name === 'Blueprint.esm', false)).toEqual(snapshot.active);
  });
});
