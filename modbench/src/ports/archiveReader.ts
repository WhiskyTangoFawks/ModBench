/** Reads an archive file. The archive format belongs to the tool behind it, so the composition
 *  root implements it and install is handed it. */
export interface ArchiveReader {
  /** The archive's file entries, as `/`-separated paths. */
  list(archivePath: string): Promise<string[]>;
  extract(archivePath: string, destDir: string): Promise<void>;
}
