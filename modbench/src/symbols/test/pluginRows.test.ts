import { describe, expect, it } from 'vitest';
import { pluginRowsOf } from '../pluginRows';

const row = (name: string, origin: string, line: number | null, winning = true) => ({ name, origin, path: `/${origin}/${name}`, line, enabled: true, winning });

describe('the plugins of the instance (ADR-0013)', () => {
  it('hold the plugins the game loads with no line beside the plugins with a line', () => {
    const rows = pluginRowsOf({
      plugins: [row('Mod.esp', 'Mod', 0)],
      pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }],
    });

    expect(rows.map(({ name, origin, winning }) => ({ name, origin, winning }))).toEqual([
      { name: 'Fallout4.esm', origin: 'Data/', winning: true },
      { name: 'Mod.esp', origin: 'Mod', winning: true },
    ]);
  });
});
