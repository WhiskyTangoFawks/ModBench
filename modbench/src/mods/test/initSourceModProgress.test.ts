import { describe, it, expect } from 'vitest';
import { initSourceModProgressMessage } from '../initSourceModProgress';

describe('the init source mod phase line', () => {
  it.each([
    ['Parsing', 'Initializing source mod "MyMod" — parsing…'],
    ['Serializing', 'Initializing source mod "MyMod" — serializing…'],
    ['ReadingFiles', 'Initializing source mod "MyMod" — reading its files…'],
    ['Committing', 'Initializing source mod "MyMod" — writing the repository…'],
    [undefined, 'Initializing source mod "MyMod"…'],
    [null, 'Initializing source mod "MyMod"…'],
  ] as const)('says %s as %s', (phase, message) => {
    expect(initSourceModProgressMessage('MyMod', phase)).toBe(message);
  });
});
