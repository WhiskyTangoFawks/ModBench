import { collectingWrites, type WriteSink } from '../ports/writeNaming';

/** The files a write wrote, which the read after it checks. A write that names none, or says it cannot tell, leaves the whole disk to check. */
export class WrittenFiles implements WriteSink {
  private files: Set<string> | undefined;
  private told = true;

  name(paths: readonly string[]): void {
    this.files ??= new Set();
    for (const path of paths) this.files.add(path);
  }

  leaveUnnamed(): void {
    this.told = false;
  }

  get named(): readonly string[] | undefined {
    return this.told && this.files ? [...this.files] : undefined;
  }

  /** Runs `work`, every write of which, through the Instance adapter, names its files here. */
  collecting<T>(work: () => Promise<T>): Promise<T> {
    return collectingWrites(this, work);
  }
}
