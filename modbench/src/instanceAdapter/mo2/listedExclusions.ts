import type { UnwatchedFolder } from '../instanceAdapter';
import type { Exclusion } from '../watcherExclusion';

export const EXCLUDED = 'excluded in files.watcherExclude';

interface Listing {
  readonly folders: readonly string[];
  readonly files: readonly string[];
  excludedFolders: readonly string[];
  excludedFilePatterns: readonly string[];
}

/** What each read of an origin's files listed, and which of it the user excluded from VS Code's watch. */
export function listedExclusions(exclusion: () => Exclusion, watchedBases: readonly string[]) {
  const listings = new Map<string, Listing>();
  const judged = (listing: Listing): Listing => {
    listing.excludedFolders = exclusion().topmostExcluded(listing.folders);
    listing.excludedFilePatterns = exclusion().patternsExcludingFiles(listing.files);
    return listing;
  };
  // A listing's files are named at the watched base it sits under.
  const baseOf = (listing: Listing): string | undefined =>
    watchedBases.filter((base) => listing.folders.some((folder) => folder.startsWith(base))).sort((a, b) => b.length - a.length)[0];

  return {
    set(key: string, listing: { readonly folders: readonly string[]; readonly files: readonly string[] } | undefined): void {
      if (listing === undefined) listings.delete(key);
      else listings.set(key, judged({ ...listing, excludedFolders: [], excludedFilePatterns: [] }));
    },
    judgedAgain(): void {
      for (const listing of listings.values()) judged(listing);
    },
    excludedFolders: (): string[] => [...new Set([...listings.values()].flatMap(({ excludedFolders }) => excludedFolders))],
    named: (): UnwatchedFolder[] => [...new Map([...listings.values()].flatMap((listing) => [
      ...listing.excludedFolders.map((folder) => ({ folder, reason: EXCLUDED })),
      ...listing.excludedFilePatterns.flatMap((pattern) => {
        const folder = baseOf(listing);
        return folder === undefined ? [] : [{ folder, reason: `files matching ${pattern} are ${EXCLUDED}` }];
      }),
    ]).map((named) => [`${named.folder}\0${named.reason}`, named])).values()],
  };
}
