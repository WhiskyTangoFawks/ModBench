import { delimiter } from 'node:path';
import type { MEditClient } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

const LINE = /^(\s*(?:export\s+)?)(\w+)(\s*=\s*)(.*?)(\r?\n)?$/;
const VALUE = /^(?:(["'])(.*?)\1|(.*?))(\s+#.*)?\s*$/;

/** Writes PYTHONPATH and MEDIT_PORT into the file `python.envFile` names, for the launchers that read it.
 *  Only a window whose mEdit holds the record index writes: a second window's mEdit would capture the first's notebooks. */
export function reachMEditFromEnvFile(options: {
  client: Pick<MEditClient, 'onPort' | 'onLoadOrderStatus' | 'loadOrderStatus'>;
  scriptsPath: string;
  /** Absent for a window with no instance. */
  envFile: Pick<InstanceAdapter['scriptEnvironmentFile'], 'read' | 'write'> | undefined;
  fail: (message: string, detail: string) => void;
}): { dispose(): void } {
  const { client, scriptsPath, envFile, fail } = options;
  if (envFile === undefined) return { dispose: () => undefined };
  let port: number | undefined;
  let writing = Promise.resolve();
  const write = () => {
    const { loadOrderStatus } = client;
    if (port === undefined || loadOrderStatus === undefined || loadOrderStatus.refusal?.kind === 'heldElsewhere') return;
    const reported = port;
    writing = writing.then(async () => {
      try {
        const held = await envFile.read();
        const text = withOurLines(held, scriptsPath, reported);
        if (text !== held) await envFile.write(text);
      } catch (err) {
        fail('Could not write the script environment file, so a notebook or a debug launch cannot import medit.', err instanceof Error ? err.message : String(err));
      }
    });
  };
  const stopPort = client.onPort((now) => { port = now; write(); });
  const stopStatus = client.onLoadOrderStatus(write);
  return { dispose: () => { stopPort(); stopStatus(); } };
}

function withOurLines(text: string, scriptsPath: string, port: number): string {
  const lines = text.split(/(?<=\n)/).filter((line) => line !== '');
  const eol = /\r?\n/.exec(text)?.[0] ?? '\n';
  setLine(lines, eol, 'PYTHONPATH', (held) => quoted([scriptsPath, ...entriesOf(held).filter((entry) => entry !== scriptsPath)].join(delimiter)));
  setLine(lines, eol, 'MEDIT_PORT', () => String(port));
  return lines.join('');
}

function setLine(lines: string[], eol: string, name: string, valueOf: (held: string | undefined) => string): void {
  const parsed = lines.map((line) => LINE.exec(line));
  const at = parsed.flatMap((match, index) => match?.[2] === name ? [index] : []);
  const last = parsed[at.at(-1) ?? -1];
  const value = valueOf(last ? splitValue(last[4] ?? '').value : undefined);
  if (at.length === 0) {
    appendLine(lines, `${name}=${value}`, eol);
    return;
  }
  for (const index of at) {
    const [, lead = '', , equals = '', own = '', ending = ''] = parsed[index] ?? [];
    lines[index] = `${lead}${name}${equals}${value}${splitValue(own).comment}${ending}`;
  }
}

function appendLine(lines: string[], line: string, eol: string): void {
  const unfinished = lines.at(-1);
  if (unfinished !== undefined && !unfinished.endsWith('\n')) lines[lines.length - 1] = unfinished + eol;
  lines.push(line + eol);
}

function splitValue(raw: string): { value: string; comment: string } {
  const [, , quotedValue, bareValue, comment] = VALUE.exec(raw) ?? [];
  return { value: quotedValue ?? bareValue ?? '', comment: comment ?? '' };
}

function entriesOf(value: string | undefined): string[] {
  return (value ?? '').split(delimiter).filter((entry) => entry !== '');
}

function quoted(value: string): string {
  return /[\s#]/.test(value) ? `'${value}'` : value;
}
