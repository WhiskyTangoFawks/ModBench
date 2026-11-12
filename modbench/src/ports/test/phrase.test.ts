import { describe, expect, it } from 'vitest';
import { forAgent, gestureName, phrase, viewOnly } from '../phrase';

const toolOf = (command: string): string => `<${command}>`;
const build = gestureName('modbench.mod.build', 'Build Mod');

describe('a phrase', () => {
  it('reads to a view as the words it was written with, and to an agent as the tool of each gesture without the words only a view reads', () => {
    const message = phrase`run ${build}${viewOnly(', in this menu,')} on it`;

    expect([String(message), forAgent(message, toolOf)]).toEqual(['run Build Mod, in this menu, on it', 'run <modbench.mod.build> on it']);
  });

  it('keeps the gestures of a phrase it is written into', () => {
    const inner = phrase`run ${build}`;

    expect(forAgent(phrase`its manifest was written, but ${inner}`, toolOf)).toBe('its manifest was written, but run <modbench.mod.build>');
  });

  it('leaves a plain string as it is, whatever it quotes', () => {
    expect(forAgent('“Build Mod” is a name', toolOf)).toBe('“Build Mod” is a name');
  });
});
