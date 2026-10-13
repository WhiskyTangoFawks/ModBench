export interface ArchiveReader {
  /** The archive's file entries, as `/`-separated paths. */
  list(archivePath: string): Promise<string[]>;
  extract(archivePath: string, destDir: string): Promise<void>;
}
