import { describe, it, expect } from 'vitest';
import { nexusSlugForGame } from './nexusSlug';

describe('nexusSlugForGame', () => {
  it('maps a known MO2 game name to its Nexus slug', () => {
    expect(nexusSlugForGame('Fallout 4')).toBe('fallout4');
    expect(nexusSlugForGame('Skyrim Special Edition')).toBe('skyrimspecialedition');
    // Each mapping is independent real data, so each earns its own assertion.
    expect(nexusSlugForGame('Fallout 3')).toBe('fallout3');
    expect(nexusSlugForGame('Fallout New Vegas')).toBe('newvegas');
    expect(nexusSlugForGame('Skyrim')).toBe('skyrim');
    expect(nexusSlugForGame('Enderal')).toBe('enderal');
    expect(nexusSlugForGame('Oblivion')).toBe('oblivion');
    expect(nexusSlugForGame('Morrowind')).toBe('morrowind');
  });

  it('maps VR variants to their non-VR Nexus domain', () => {
    expect(nexusSlugForGame('Fallout 4 VR')).toBe('fallout4');
    expect(nexusSlugForGame('Skyrim VR')).toBe('skyrimspecialedition');
  });

  it('falls back to a lowercased, space-stripped name for an unknown game', () => {
    expect(nexusSlugForGame('Some Game')).toBe('somegame');
  });
});
