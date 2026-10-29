export interface InstallationFileReader {
  /** The installation file's file entries, as `/`-separated paths. */
  list(installationFilePath: string): Promise<string[]>;
  extract(installationFilePath: string, destDir: string): Promise<void>;
}
