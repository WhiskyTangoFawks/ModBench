import { describe, it, expect } from 'vitest';
import { commandTitles } from '../commandTitles';

describe('the titles of the commands package.json contributes', () => {
  it('maps each Command ID to its title', () => {
    const packageJson = { contributes: { commands: [{ command: 'modbench.mod.build', title: 'Build Mod', category: 'Modbench' }] } };

    expect(commandTitles(packageJson)).toEqual(new Map([['modbench.mod.build', 'Build Mod']]));
  });

  it('is empty for a package.json that contributes none', () => {
    expect(commandTitles({})).toEqual(new Map());
  });
});
