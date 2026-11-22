export interface WriteSink {
  name(paths: readonly string[]): void;
  leaveUnnamed(): void;
  /** The subscribers a told write's read woke, which the command waits on before it ends. */
  settling(subscribed: Promise<void>): void;
}
