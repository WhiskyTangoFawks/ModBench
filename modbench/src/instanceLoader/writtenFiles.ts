import type { WriteSink } from '../ports/writeSink';

/** The files a write wrote that the Instance adapter's write does not tell the loader of, which the read after it checks. A write
 *  that says it cannot tell leaves the whole disk to check. */
export class WrittenFiles implements WriteSink {
  private readonly files = new Set<string>();
  private told = true;
  private readonly subscribers: Promise<void>[] = [];

  name(paths: readonly string[]): void {
    for (const path of paths) this.files.add(path);
  }

  leaveUnnamed(): void {
    this.told = false;
  }

  settling(subscribed: Promise<void>): void {
    this.subscribers.push(subscribed);
  }

  /** Settles once the subscribers every told write woke have. */
  async subscribed(): Promise<void> {
    await Promise.all(this.subscribers);
  }

  get named(): readonly string[] | undefined {
    return this.told ? [...this.files] : undefined;
  }
}
