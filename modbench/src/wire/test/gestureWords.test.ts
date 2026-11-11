import { describe, expect, it } from 'vitest';
import { gestureWord, gestureWordsNamed } from '../gestureWords';

describe('a gesture word', () => {
  it('is replaced by what the entry point names its command, and a plain word of the same letters is left', () => {
    const text = `its build records its folder: run ${gestureWord('modbench.mod.build')} on it, then build again`;

    expect(gestureWordsNamed(text, (command) => `<${command}>`)).toBe('its build records its folder: run <modbench.mod.build> on it, then build again');
  });
});
