/** What Nexus knows of a file and its mod, each field only when Nexus names it. `game` is Nexus's domain for the game. */
export interface NexusFileInfo {
  readonly game: string;
  readonly modID: string;
  readonly fileID: string;
  readonly name?: string;
  readonly version?: string;
  readonly fileCategory?: number;
  readonly modName?: string;
  readonly category?: number;
  readonly author?: string;
  readonly uploader?: string;
  readonly uploaderUrl?: string;
}
