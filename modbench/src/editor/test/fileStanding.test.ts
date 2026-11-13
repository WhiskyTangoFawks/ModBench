import { describe, expect, it } from 'vitest';
import { fileStanding } from '../fileStanding';

const OVERRIDDEN = { kind: 'overridden', by: 'ModB' } as const;

describe('the standing of the file\'s column', () => {
  it.each([
    ['overridden', OVERRIDDEN, { overriddenBy: 'ModB', notActive: false }],
    ['disabled', { kind: 'disabled' } as const, { overriddenBy: null, notActive: true }],
    ['enabled', { kind: 'enabled' } as const, { overriddenBy: null, notActive: false }],
  ])('for a plugin the game does not load that the instance says is %s', (_case, standing, expected) => {
    expect(fileStanding({ pluginActive: false, columnsShown: false, standing })).toEqual(expected);
  });

  it('is none for a plugin the game loads', () => {
    expect(fileStanding({ pluginActive: true, columnsShown: false, standing: OVERRIDDEN })).toEqual({ overriddenBy: null, notActive: false });
  });

  it('is none when other columns are shown beside it', () => {
    expect(fileStanding({ pluginActive: false, columnsShown: true, standing: OVERRIDDEN })).toEqual({ overriddenBy: null, notActive: false });
  });
});
