export interface WriteSink {
  name(paths: readonly string[]): void;
  leaveUnnamed(): void;
}
