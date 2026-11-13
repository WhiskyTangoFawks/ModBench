/** The files a write wrote, which the read after it checks. A write that names none leaves the whole disk to check. */
export class WrittenFiles {
  private files: Set<string> | undefined;

  name(paths: readonly string[]): void {
    this.files ??= new Set();
    for (const path of paths) this.files.add(path);
  }

  get named(): readonly string[] | undefined {
    return this.files && [...this.files];
  }
}
