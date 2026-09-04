import type { LogOutputChannel } from 'vscode';

type LeveledChannel = Pick<LogOutputChannel, 'debug' | 'info' | 'warn' | 'error'>;

// Serilog's `{Level:u3}` tokens, as they appear in its default console template.
const LEVELS: Record<string, keyof LeveledChannel> = {
  VRB: 'debug', DBG: 'debug', INF: 'info', WRN: 'warn', ERR: 'error', FTL: 'error',
};

// `[HH:mm:ss LVL] ` — the leading half of Serilog's default console template.
const TAG = /^\[\d{2}:\d{2}:\d{2} ([A-Z]{3})\] /;

export type BackendStream = 'stdout' | 'stderr';

// Serilog tags everything it writes to stdout; untagged stderr is the runtime itself (a crash dump).
const UNTAGGED: Record<BackendStream, keyof LeveledChannel> = { stdout: 'info', stderr: 'error' };

/** Stateful by necessity — Serilog appends stack traces as untagged lines, so a continuation
 *  inherits the last level seen on its stream; letting stdout's level leak into stderr would file
 *  a crash dump under whatever routine line arrived last. */
export function makeBackendLogForwarder(channel: LeveledChannel): (line: string, source: BackendStream) => void {
  const level = { ...UNTAGGED };
  return (line, source) => {
    if (!line.trim()) return;
    const tag = TAG.exec(line);
    if (tag && tag[1] in LEVELS) {
      level[source] = LEVELS[tag[1]];
      line = line.slice(tag[0].length); // channel stamps its own timestamp + level
    }
    channel[level[source]](`[backend] ${line}`);
  };
}

// `vscode.LogLevel`'s ordinals (Off=0, Trace=1 .. Error=5). Untyped as `number` so this file
// needs no runtime `vscode` import, and so no VS Code test harness.
const SERILOG_LEVEL_NAMES: Record<number, string> = {
  1: 'Verbose', 2: 'Debug', 3: 'Information', 4: 'Warning', 5: 'Error',
};

/** Makes Serilog's minimum level follow the Output channel's for that process's lifetime. An Off
 *  level (0) or anything unrecognized returns `[]`, leaving the backend on its own
 *  `appsettings.json` default. */
export function backendLogLevelArgs(level: number): string[] {
  const name = SERILOG_LEVEL_NAMES[level];
  return name ? ['--Serilog:MinimumLevel:Default', name] : [];
}
