import type { FileReads } from '../sortingRules/lootConditions';

/** The Instance adapter's reads of a file, by path relative to the Data folder and the path mod order provides it from. */
interface DataFileAdapter {
  dataFileChecksum: (path: string, winner: string | undefined) => Promise<number | undefined>;
  dataFileVersion: (path: string, winner: string | undefined, field: 'file' | 'product') => Promise<string | undefined>;
  dataFileReadable: (path: string, winner: string | undefined) => Promise<boolean>;
}

/** The Instance adapter's file reads, each at the file mod order provides, else the game folder's. */
export function fileReadsOver(adapter: DataFileAdapter, winners: () => { get: (path: string) => { winner: string } | undefined }): FileReads {
  const forward = (path: string): string => path.replace(/\\/g, '/');
  const winnerOf = (path: string): string | undefined => winners().get(path)?.winner;
  return {
    checksum: (path) => adapter.dataFileChecksum(forward(path), winnerOf(forward(path))),
    version: (path, field) => adapter.dataFileVersion(forward(path), winnerOf(forward(path)), field),
    readable: (path) => adapter.dataFileReadable(forward(path), winnerOf(forward(path))),
  };
}
