/** A failure logs at warn or error; a note that is not a failure logs at info. */
export interface Log {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

export const SILENT_LOG: Log = { info: () => {}, warn: () => {}, error: () => {} };
