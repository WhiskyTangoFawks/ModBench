// The slug is the {game} segment of https://www.nexusmods.com/{game}/mods/{modID};
// the keys are MO2's own game names, as ModOrganizer.ini spells them.

const NEXUS_SLUGS: Record<string, string> = {
  'Fallout 4': 'fallout4',
  'Fallout 4 VR': 'fallout4',
  'Fallout 3': 'fallout3',
  'Fallout New Vegas': 'newvegas',
  'Skyrim': 'skyrim',
  'Skyrim Special Edition': 'skyrimspecialedition',
  'Skyrim VR': 'skyrimspecialedition',
  'Enderal': 'enderal',
  'Oblivion': 'oblivion',
  'Morrowind': 'morrowind',
};

/** Nexus slug for an MO2 game name; unknown games fall back to the lowercased,
 *  space-stripped name (a best guess that matches most Nexus domains). */
export function nexusSlugForGame(gameName: string): string {
  return NEXUS_SLUGS[gameName] ?? gameName.toLowerCase().replace(/\s+/g, '');
}
