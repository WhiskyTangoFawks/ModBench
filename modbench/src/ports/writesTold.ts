export interface WritesTold {
  /** Answers once the read model holds the files a write wrote. */
  told(paths: readonly string[]): Promise<void>;
}
