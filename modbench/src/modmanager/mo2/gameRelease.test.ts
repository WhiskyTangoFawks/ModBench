import { describe, it, expect } from 'vitest';
import { gameReleaseForGame } from './gameRelease';

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
