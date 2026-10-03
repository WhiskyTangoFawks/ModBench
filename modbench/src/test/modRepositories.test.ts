import { describe, it, expect } from 'vitest';
import { modRepositoryContext } from '../modRepositories';
import { instanceValueFixture } from './mo2/instanceValueFixture';

const pluginIn = (origin: string, name: string) => ({ name, origin, path: `/instance/mods/${origin}/${name}`, slot: 0, enabled: true, winning: true });

describe('which plugin origins have a repository, for the column header', () => {
  it('names each origin by whether its mod has one, and no origin that is not a mod', () => {
    expect(modRepositoryContext(instanceValueFixture({
      mods: [
        { kind: 'mod', name: 'Tracked', enabled: true },
        { kind: 'separator', name: 'Group', enabled: true },
        { kind: 'mod', name: 'Untracked', enabled: false },
      ],
      trackedMods: new Set(['Tracked']),
      plugins: [pluginIn('Tracked', 'A.esp'), pluginIn('Tracked', 'B.esp'), pluginIn('Untracked', 'C.esp'), pluginIn('overwrite', 'D.esp')],
    }))).toEqual({ tracked: ['Tracked'], untracked: ['Untracked'] });
  });

  it('carries the origin as the plugins spell it when it differs in case from the mod', () => {
    expect(modRepositoryContext(instanceValueFixture({
      mods: [{ kind: 'mod', name: 'Harder VATS', enabled: true }, { kind: 'mod', name: 'Other', enabled: true }],
      trackedMods: new Set(['Harder VATS']),
      plugins: [pluginIn('harder vats', 'A.esp'), pluginIn('OTHER', 'B.esp')],
    }))).toEqual({ tracked: ['harder vats'], untracked: ['OTHER'] });
  });
});
