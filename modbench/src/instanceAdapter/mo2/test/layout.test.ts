import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { manifestFileIn, modDir } from '../layout';

const ROOT = join('/tmp', 'instance');

describe('MO2 layout', () => {
  it('names a mod\'s manifest for the mod, with the JSON suffix', () => {
    expect(manifestFileIn(join('mods', 'Mod A'), 'Mod A')).toBe(join('mods', 'Mod A', 'Mod A.manifest.json'));
  });

  it('joins a name with separators in it as one more path segment, never as a second argument', () => {
    expect(modDir(ROOT, 'A/B')).toBe(join(ROOT, 'mods', 'A/B'));
  });
});
