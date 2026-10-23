/** What Nexus knows of a file and its mod, each field only when Nexus names it. `game` is Nexus's domain for the game. */
export interface NexusFileInfo {
  readonly game: string;
  readonly modID: string;
  readonly fileID: string;
  readonly name?: string;
  readonly version?: string;
  /** The version of the mod the file belongs to, which stands for the file's own when that is not a version. */
  readonly modVersion?: string;
  /** As Nexus writes it, in BBCode. */
  readonly description?: string;
  readonly fileCategory?: number;
  readonly modName?: string;
  readonly category?: number;
  readonly author?: string;
  readonly uploader?: string;
  readonly uploaderUrl?: string;
}
