import { describe, it, expect } from 'vitest';
import { gameReleaseForGame, nexusSlugForGame, gamePathInfoForRelease } from './gamePaths';

describe('gameReleaseForGame', () => {
  it('maps a known MO2 game name to Mutagen\'s release name', () => {
    // Each mapping is independent real data, so each earns its own assertion.
    expect(gameReleaseForGame('Fallout 4')).toBe('Fallout4');
    expect(gameReleaseForGame('Fallout 4 VR')).toBe('Fallout4VR');
    expect(gameReleaseForGame('Fallout 3')).toBe('Fallout3');
    expect(gameReleaseForGame('Fallout New Vegas')).toBe('FalloutNV');
    expect(gameReleaseForGame('Skyrim Special Edition')).toBe('SkyrimSE');
    expect(gameReleaseForGame('Skyrim VR')).toBe('SkyrimVR');
    expect(gameReleaseForGame('Enderal')).toBe('EnderalLE');
    expect(gameReleaseForGame('Oblivion')).toBe('Oblivion');
  });

  // The one name whose two vocabularies disagree beyond spacing: MO2 says "Skyrim" for what
  // Mutagen calls the Legendary Edition, so a whitespace strip would answer a release that
  // does not exist.
  it('maps MO2\'s bare "Skyrim" to the Legendary Edition, not to "Skyrim"', () => {
    expect(gameReleaseForGame('Skyrim')).toBe('SkyrimLE');
  });

  // Every value has to be a name the backend's Enum.TryParse<GameRelease> accepts, so a game
  // Mutagen has no release for gets no entry rather than a plausible-looking one.
  it('answers undefined for a game Mutagen has no release for', () => {
    expect(gameReleaseForGame('Morrowind')).toBeUndefined();
  });

  it('answers undefined for an unknown game rather than guessing one', () => {
    expect(gameReleaseForGame('Some Game')).toBeUndefined();
    expect(gameReleaseForGame('')).toBeUndefined();
  });
});

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
  });

  it('maps VR variants to their non-VR Nexus domain', () => {
    expect(nexusSlugForGame('Fallout 4 VR')).toBe('fallout4');
    expect(nexusSlugForGame('Skyrim VR')).toBe('skyrimspecialedition');
  });

  // Morrowind has no release (gameReleaseForGame is undefined for it), so this exercises the
  // fallback path rather than a table row — the fallback happens to match Nexus's own slug.
  it('falls back to a lowercased, space-stripped name for Morrowind and other unknown games', () => {
    expect(nexusSlugForGame('Morrowind')).toBe('morrowind');
    expect(nexusSlugForGame('Some Game')).toBe('somegame');
  });
});

describe('gamePathInfoForRelease', () => {
  it('answers Fallout 4\'s Steam install facts', () => {
    expect(gamePathInfoForRelease('Fallout4')).toEqual({
      mo2Name: 'Fallout 4',
      nexusSlug: 'fallout4',
      steamAppId: '377160',
      steamFolderName: 'Fallout 4',
    });
  });

  // A release the table only knows the Nexus slug for carries no Steam facts — the
  // autodetector's signal to give up rather than guess a folder.
  it('answers no Steam facts for a release the table cannot autodetect', () => {
    expect(gamePathInfoForRelease('SkyrimSE')).toEqual({ mo2Name: 'Skyrim Special Edition', nexusSlug: 'skyrimspecialedition' });
  });

  it('answers undefined for a release the table holds no row for', () => {
    expect(gamePathInfoForRelease('SomeRelease')).toBeUndefined();
  });
});
