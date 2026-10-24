import { describe, it, expect, vi } from 'vitest';
import { warnIfFomod } from '../fomodWarning';

describe('a FOMOD installed as a plain copy', () => {
  it('warns that its files need arranging by hand, because its installer\'s steps did not run, and why', () => {
    const report = vi.fn();
    warnIfFomod({ report })('Some Mod', { kind: 'plainCopy', why: 'Manual was asked for' });
    expect(report).toHaveBeenCalledWith('warning',
      '"Some Mod" is a FOMOD installed as a plain copy: its files need arranging by hand, because its installer\'s own steps did not run: Manual was asked for.');
  });

  it.each([
    ['a mod that is not one', undefined],
    ['a FOMOD its installer installed', { kind: 'installer', missing: [] } as const],
  ])('says nothing for %s', (_, fomod) => {
    const report = vi.fn();
    warnIfFomod({ report })('Some Mod', fomod);
    expect(report).not.toHaveBeenCalled();
  });
});
