import type { Log } from '../ports/log';

export interface LeveledLog extends Log {
  readonly lines: { info: string[]; warn: string[]; error: string[] };
}

export function leveledLog(): LeveledLog {
  const lines = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  return {
    lines,
    info: (line) => lines.info.push(line),
    warn: (line) => lines.warn.push(line),
    error: (line) => lines.error.push(line),
  };
}
