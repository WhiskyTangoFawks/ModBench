import { describe, it, expect, vi } from 'vitest';
import { warnIfFomod } from '../fomodWarning';

describe('a FOMOD installer is copied as-is', () => {
  it('warns that its files need manual arrangement', () => {
    const report = vi.fn();
    warnIfFomod({ report })('Some Mod', true);
    expect(report).toHaveBeenCalledWith('warning', expect.stringContaining('"Some Mod" is a FOMOD installer'));
  });

  it('says nothing for a mod that is not one', () => {
    const report = vi.fn();
    warnIfFomod({ report })('Some Mod', false);
    expect(report).not.toHaveBeenCalled();
  });
});
