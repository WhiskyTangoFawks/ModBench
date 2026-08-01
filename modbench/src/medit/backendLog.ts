import type { LogOutputChannel } from 'vscode';

type LeveledChannel = Pick<LogOutputChannel, 'debug' | 'info' | 'warn' | 'error'>;

/** Serilog's `{Level:u3}` tokens, as they appear in its default console template. */
const LEVELS: Record<string, keyof LeveledChannel> = {
  VRB: 'debug', DBG: 'debug', INF: 'info', WRN: 'warn', ERR: 'error', FTL: 'error',
};

/** `[HH:mm:ss LVL] ` — the leading half of Serilog's default console template. */
const TAG = /^\[\d{2}:\d{2}:\d{2} ([A-Z]{3})\] /;

/** Routes one line of backend console output to the matching leveled call on the
 *  Modbench channel (#199). The only backend→frontend coupling this introduces is
 *  Serilog's console template, and it is deliberately tolerant: an unrecognized
 *  line is still forwarded, never dropped or thrown on.
 *
 *  Stateful by necessity — Serilog appends exception stack traces as untagged
 *  lines after their message, so a continuation inherits the last seen level
 *  instead of being demoted out of the reader's level filter. */
export function makeBackendLogForwarder(channel: LeveledChannel): (line: string) => void {
  let level: keyof LeveledChannel = 'info';
  return (line) => {
    if (!line.trim()) return;
    const tag = TAG.exec(line);
    if (tag && tag[1] in LEVELS) {
      level = LEVELS[tag[1]];
      line = line.slice(tag[0].length); // channel stamps its own timestamp + level
    }
    channel[level](`[backend] ${line}`);
  };
}
