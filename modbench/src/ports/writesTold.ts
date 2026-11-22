export interface WritesTold {
  /** Answers once the read model holds the files a write wrote, with when the subscribers that read woke have settled. */
  told(paths: readonly string[]): Promise<{ readonly subscribed: Promise<void> }>;
}
