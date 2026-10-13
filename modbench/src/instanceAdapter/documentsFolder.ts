import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const COMMAND = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Environment]::GetFolderPath('MyDocuments')";

const powershell = (command: string): Promise<Buffer> =>
  execFileAsync('powershell', ['-NoProfile', '-Command', command], { encoding: 'buffer' }).then((r) => r.stdout);

/** The Documents known folder as Windows has it, read as UTF-8 whatever the console's code page. */
export async function documentsFolder(run: (command: string) => Promise<Buffer> = powershell): Promise<string> {
  return (await run(COMMAND)).toString('utf8').replace(/^﻿/, '').trim();
}
