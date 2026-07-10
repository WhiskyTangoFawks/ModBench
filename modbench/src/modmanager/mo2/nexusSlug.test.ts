import { describe, it, expect } from 'vitest';
import { nexusSlugForGame } from './nexusSlug';

describe('nexusSlugForGame', () => {
  it('maps a known MO2 game name to its Nexus slug', () => {
    expect(nexusSlugForGame('Fallout 4')).toBe('fallout4');
    expect(nexusSlugForGame('Skyrim Special Edition')).toBe('skyrimspecialedition');
  });

  it('maps VR variants to their non-VR Nexus domain', () => {
    expect(nexusSlugForGame('Fallout 4 VR')).toBe('fallout4');
    expect(nexusSlugForGame('Skyrim VR')).toBe('skyrimspecialedition');
  });

  it('falls back to a lowercased, space-stripped name for an unknown game', () => {
    expect(nexusSlugForGame('Some Game')).toBe('somegame');
  });
});
