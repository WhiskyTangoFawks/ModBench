// MO2's game names, as ModOrganizer.ini spells them, to Mutagen's GameRelease names, which every
// backend route parses. The two differ by more than spacing — "Skyrim" is SkyrimLE — so nothing
// derives one from the other.

// Keyed exactly as nexusSlug.ts is, one vocabulary for MO2's own game names. Morrowind is absent
// on purpose: Mutagen has no release for it, so there is nothing the backend could be asked.
const GAME_RELEASES: Record<string, string> = {
  'Fallout 4': 'Fallout4',
  'Fallout 4 VR': 'Fallout4VR',
  'Fallout 3': 'Fallout3',
  'Fallout New Vegas': 'FalloutNV',
  'Skyrim': 'SkyrimLE',
  'Skyrim Special Edition': 'SkyrimSE',
  'Skyrim VR': 'SkyrimVR',
  'Enderal': 'EnderalLE',
  'Oblivion': 'Oblivion',
};

/** Mutagen's release name for an MO2 game name, `undefined` when the table holds none. Never a
 *  guess: a wrong release makes the backend answer about another game, which reads as a
 *  confident wrong answer rather than an absent one. */
export function gameReleaseForGame(gameName: string): string | undefined {
  return GAME_RELEASES[gameName];
}
