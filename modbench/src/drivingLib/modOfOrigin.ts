/** The mod an origin names, as the instance value spells it, or none when no mod folder carries
 *  that name: Overwrite and the game's Data folder are origins of plugins that no mod provides. */
export function modOfOrigin(modDirs: ReadonlyMap<string, string>, origin: string): string | undefined {
  const folded = origin.toLowerCase();
  return [...modDirs.keys()].find((name) => name.toLowerCase() === folded);
}
