import type { FileReads } from '../sortingRules/lootConditions';
import type { DataFileReads } from '../instanceAdapter/gameFolder/dataFileReads';
import type { FileWinners } from '../instanceLoader/fileConflictIndex';

/** The Instance adapter's file reads, each at the file mod order provides, else the game folder's. */
export function fileReadsOver(adapter: DataFileReads, winners: () => Pick<FileWinners, 'get'>): FileReads {
  const forward = (path: string): string => path.replace(/\\/g, '/');
  const winnerOf = (path: string): string | undefined => winners().get(path)?.winner;
  return {
    checksum: (path) => adapter.dataFileChecksum(forward(path), winnerOf(forward(path))),
    version: (path, field) => adapter.dataFileVersion(forward(path), winnerOf(forward(path)), field),
    readable: (path) => adapter.dataFileReadable(forward(path), winnerOf(forward(path))),
  };
}
