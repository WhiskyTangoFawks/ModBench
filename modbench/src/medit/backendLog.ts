import type { LogOutputChannel } from 'vscode';

type LeveledChannel = Pick<LogOutputChannel, 'debug' | 'info' | 'warn' | 'error'>;

/** Serilog's `{Level:u3}` tokens, as they appear in its default console template. */
const LEVELS: Record<string, keyof LeveledChannel> = {
  VRB: 'debug', DBG: 'debug', INF: 'info', WRN: 'warn', ERR: 'error', FTL: 'error',
};

/** `[HH:mm:ss LVL] ` — the leading half of Serilog's default console template. */
const TAG = /^\[\d{2}:\d{2}:\d{2} ([A-Z]{3})\] /;

export type BackendStream = 'stdout' | 'stderr';

/** Level an untagged line falls back to. Serilog tags everything it writes to
 *  stdout; untagged stderr is the runtime itself (a .NET crash dump), which must
 *  not arrive as routine chatter. */
const UNTAGGED: Record<BackendStream, keyof LeveledChannel> = { stdout: 'info', stderr: 'error' };

/** Routes one line of backend console output to the matching leveled call on the
 *  Modbench channel (#199). The only backend→frontend coupling this introduces is
 *  Serilog's console template, and it is deliberately tolerant: an unrecognized
 *  line is still forwarded, never dropped or thrown on.
 *
 *  Stateful by necessity — Serilog appends exception stack traces as untagged
 *  lines after their message, so a continuation inherits the last seen level
 *  instead of being demoted out of the reader's level filter. That carry-over is
 *  tracked per stream: the two are written independently, so letting stdout's
 *  level leak into stderr would file a crash dump under whatever routine line
 *  happened to arrive last. */
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

/** `vscode.LogLevel`'s numeric ordinals (Off=0, Trace=1 .. Error=5), mapped to
 *  Serilog's level names. Untyped as `number` rather than `vscode.LogLevel` so
 *  this stays a plain value mapping — no runtime `vscode` import, so no VS Code
 *  test harness needed here (#205). */
const SERILOG_LEVEL_NAMES: Record<number, string> = {
  1: 'Verbose', 2: 'Debug', 3: 'Information', 4: 'Warning', 5: 'Error',
};

/** Backend spawn-argv fragment (issue #205) that makes Serilog's minimum level
 *  follow the Output channel's level for that process's lifetime — so raising
 *  the channel to Debug/Trace actually produces backend lines at that level for
 *  the console forwarder above to relay, not just louder frontend lines.
 *
 *  Total: an Off level (0) or anything unrecognized returns `[]` — no override,
 *  so the backend falls back to its own `appsettings.json` default. Only
 *  meaningful for a backend we spawn; an attached one never sees this (the
 *  caller only builds spawn argv when it's actually spawning). */
export function backendLogLevelArgs(level: number): string[] {
  const name = SERILOG_LEVEL_NAMES[level];
  return name ? ['--Serilog:MinimumLevel:Default', name] : [];
}
