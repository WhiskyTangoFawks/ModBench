// Table 1 of 2: every per-game fact needed to find an install and speak to Nexus, keyed by
// Mutagen's GameRelease. Table 2 (loadOrderDestination.ts) is where the running game itself
// reads its load order.

export interface GamePathInfo {
  /** MO2's own spelling, as `ModOrganizer.ini`'s `gameName=` writes it. */
  readonly mo2Name: string;
  /** The Nexus slug — the {game} segment of nexusmods.com/{game}/mods/{id}. */
  readonly nexusSlug: string;
  /** Steam's numeric app id, when the release ships on Steam. Needed to find which Steam
   *  library holds the install (`libraryfolders.vdf`) and its Proton prefix. Absent for a
   *  release the table only knows the Nexus slug for. */
  readonly steamAppId?: string;
  /** The `steamapps/common/<name>` folder holding the install. Absent alongside `steamAppId`. */
  readonly steamFolderName?: string;
}

// Only Fallout 4 carries Steam autodetection facts today — a fixture choice, not a platform lock.
const GAME_PATHS: Record<string, GamePathInfo> = {
  Fallout4: { mo2Name: 'Fallout 4', nexusSlug: 'fallout4', steamAppId: '377160', steamFolderName: 'Fallout 4' },
  Fallout4VR: { mo2Name: 'Fallout 4 VR', nexusSlug: 'fallout4' },
  Fallout3: { mo2Name: 'Fallout 3', nexusSlug: 'fallout3' },
  FalloutNV: { mo2Name: 'Fallout New Vegas', nexusSlug: 'newvegas' },
  SkyrimLE: { mo2Name: 'Skyrim', nexusSlug: 'skyrim' },
  SkyrimSE: { mo2Name: 'Skyrim Special Edition', nexusSlug: 'skyrimspecialedition' },
  SkyrimVR: { mo2Name: 'Skyrim VR', nexusSlug: 'skyrimspecialedition' },
  EnderalLE: { mo2Name: 'Enderal', nexusSlug: 'enderal' },
  Oblivion: { mo2Name: 'Oblivion', nexusSlug: 'oblivion' },
};

// mo2Name -> release, rebuilt from the table above so the two directions can never disagree.
// Morrowind resolves to no entry: Mutagen has no release for it.
const RELEASE_BY_MO2_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(GAME_PATHS).map(([release, info]) => [info.mo2Name, release]),
);

/** Mutagen's release name for an MO2 game name, `undefined` when the table holds none. Never a
 *  guess: a wrong release makes the backend answer about another game, which reads as a
 *  confident wrong answer rather than an absent one. */
export function gameReleaseForGame(mo2Name: string): string | undefined {
  return RELEASE_BY_MO2_NAME.get(mo2Name);
}

/** Nexus slug for an MO2 game name; unknown games fall back to the lowercased,
 *  space-stripped name (a best guess that matches most Nexus domains). */
export function nexusSlugForGame(mo2Name: string): string {
  const release = RELEASE_BY_MO2_NAME.get(mo2Name);
  const info = release ? GAME_PATHS[release] : undefined;
  return info?.nexusSlug ?? mo2Name.toLowerCase().replace(/\s+/g, '');
}

/** The install-location facts for a release, or `undefined` when the table holds none for it —
 *  the autodetector's signal to give up rather than guess a folder. */
export function gamePathInfoForRelease(release: string): GamePathInfo | undefined {
  return GAME_PATHS[release];
}
