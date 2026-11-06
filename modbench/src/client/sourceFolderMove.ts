import { COMMITTED, NO_FILE_CHANGES, type EntryOwner, type EntrySymbol, type HeldTexts } from '../symbolNames/symbolNames';
import { isRefused, type MEditClient, type SourceMove } from './MEditClient';

/** Where a rename of a mod takes its source folder, by absolute path, and each of the folder's files named for it, relative
 *  to the folder; undefined for a mod with no source folder named for it. */
export type SourceFolderMoveOf = (symbol: EntrySymbol, newName: string, held: HeldTexts) => Promise<
  { readonly from: string; readonly to: string; readonly files: readonly SourceMove[] } | undefined
>;

const STAYS = { changes: NO_FILE_CHANGES, cannotFollow: [], commit: () => Promise.resolve(COMMITTED) };

/** A source mod's source folder as an owner of a rename of its mod: mEdit's Source adapter answers the moves, and what git
 *  holds of the folder follows once they are applied. */
export function sourceFolderMove(client: Pick<MEditClient, 'getSourceFolderMoveChanges' | 'followSourceFolderMove'>, moveOf: SourceFolderMoveOf): EntryOwner {
  return {
    async plan(symbol, newName, held) {
      const move = await moveOf(symbol, newName, held);
      if (move === undefined) return STAYS;
      const changes = await client.getSourceFolderMoveChanges(move.from, move.to, move.files);
      if (isRefused(changes)) return { refused: changes.message };
      return {
        changes,
        cannotFollow: [],
        commit: async () => {
          const followed = await client.followSourceFolderMove(move.from, move.to);
          return isRefused(followed) ? { cannotFollow: [`${move.to}: ${followed.message}`] } : COMMITTED;
        },
      };
    },
  };
}
