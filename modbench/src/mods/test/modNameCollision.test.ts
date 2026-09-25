import { describe, it, expect } from 'vitest';
import { collidingModName } from '../modNameCollision';
import type { Instance, InstanceValue } from '../../instanceLoader/instance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const instanceWith = (mods: InstanceValue['mods']): Pick<Instance, 'value'> => ({
  value: instanceValueFixture({ mods }),
});

const mod = (name: string): InstanceValue['mods'][number] => ({ kind: 'mod', name, enabled: true });
const separator = (name: string): InstanceValue['mods'][number] => ({ kind: 'separator', name, enabled: true });

describe('collidingModName', () => {
  it('names the collision and points at the Downloads view when a mod of that name exists', () => {
    const message = collidingModName(instanceWith([mod('Harder VATS')]), 'Harder VATS');
    expect(message).toMatch(/already exists/);
    expect(message).toMatch(/Downloads/);
  });

  // MO2 keys mods by name without case (modinfo.cpp, FileNameComparator). Rival: an exact match,
  // which lets the prompt accept a name the create then refuses.
  it('names the collision for a mod of that name in another case', () => {
    expect(collidingModName(instanceWith([mod('Harder VATS')]), 'harder vats')).toMatch(/already exists/);
  });

  it('is silent for a name no mod carries', () => {
    expect(collidingModName(instanceWith([mod('Harder VATS')]), 'A New Mod')).toBeUndefined();
  });

  it('ignores a separator of the same name — only a mod folder collides', () => {
    expect(collidingModName(instanceWith([separator('Group')]), 'Group')).toBeUndefined();
  });

  it('is silent for a blank name, leaving VS Code\'s own empty-input handling alone', () => {
    expect(collidingModName(instanceWith([mod('Harder VATS')]), '   ')).toBeUndefined();
  });
});
