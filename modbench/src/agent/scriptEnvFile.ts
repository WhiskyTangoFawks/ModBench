import { delimiter } from 'node:path';
import type { MEditClient } from '../client';

const LINE = /^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/;

/** Writes PYTHONPATH and MEDIT_PORT into the file `python.envFile` names, for the launchers that read it.
 *  Only a window whose mEdit holds the record index writes: a second window's mEdit would capture the first's notebooks. */
export function reachMEditFromEnvFile(options: {
  client: Pick<MEditClient, 'onPort' | 'onLoadOrderStatus' | 'loadOrderStatus'>;
  scriptsPath: string;
  envFile: { read(): Promise<string>; write(text: string): Promise<void> };
  fail: (message: string) => void;
}): { dispose(): void } {
  const { client, scriptsPath, envFile, fail } = options;
  let port: number | undefined;
  let writing = Promise.resolve();
  const write = () => {
    const { loadOrderStatus } = client;
    if (port === undefined || loadOrderStatus === undefined || loadOrderStatus.refusal?.kind === 'heldElsewhere') return;
    const reported = port;
    writing = writing.then(async () => {
      try {
        await envFile.write(withOurLines(await envFile.read(), scriptsPath, reported));
      } catch (err) {
        fail(`Could not write the script environment file, so a notebook or a debug launch cannot import medit: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  };
  const stopPort = client.onPort((now) => { port = now; write(); });
  const stopStatus = client.onLoadOrderStatus(write);
  return { dispose: () => { stopPort(); stopStatus(); } };
}

function withOurLines(text: string, scriptsPath: string, port: number): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const set = (name: string, line: (held: string | undefined) => string) => {
    const at = lines.findIndex((each) => LINE.exec(each)?.[1] === name);
    if (at === -1) lines.push(line(undefined)); else lines[at] = line(LINE.exec(lines[at] ?? '')?.[2]);
  };
  set('PYTHONPATH', (held) => `PYTHONPATH=${valueOf([scriptsPath, ...entriesOf(held).filter((entry) => entry !== scriptsPath)])}`);
  set('MEDIT_PORT', () => `MEDIT_PORT=${port}`);
  return lines.join(eol) + eol;
}

function entriesOf(value: string | undefined): string[] {
  const unquoted = (value ?? '').replace(/^(["'])(.*)\1$/, '$2');
  return unquoted.split(delimiter).filter((entry) => entry !== '');
}

function valueOf(entries: string[]): string {
  const joined = entries.join(delimiter);
  return /[\s#]/.test(joined) ? `'${joined}'` : joined;
}
