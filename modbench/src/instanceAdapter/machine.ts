// The machine Modbench runs on, which the composition root hands the adapter.

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { promisify } from 'node:util';
import { errnoCode } from '../ports/errno';
import { stripBom } from '../loadOrderFileCodec/lineScan';
import type { Machine } from './instanceAdapter';

const execFileAsync = promisify(execFile);

// reg sets a value's name, type and data apart by four spaces.
const REG_COLUMNS = '    ';

async function registryValue(key: string, name: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync('reg', ['query', key, '/v', name], { windowsHide: true });
  for (const line of stdout.split(/\r?\n/)) {
    const [field, type, ...data] = line.trim().split(REG_COLUMNS);
    if (field === name && type === 'REG_SZ') return data.join(REG_COLUMNS).trim();
  }
  return undefined;
}

const DOCUMENTS = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Environment]::GetFolderPath('MyDocuments')";

// Read as UTF-8, whatever the console's code page, as the command tells PowerShell to write it.
const documentsFolder = async (): Promise<string> =>
  stripBom((await execFileAsync('powershell', ['-NoProfile', '-Command', DOCUMENTS], { encoding: 'buffer' })).stdout.toString('utf8')).trim();

async function linuxProcessName(pid: string): Promise<string | undefined> {
  try {
    return (await readFile(`/proc/${pid}/comm`, 'utf8')).trimEnd();
  } catch (err) {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ESRCH') return undefined;
    throw err;
  }
}

async function linuxProcesses(): Promise<string[]> {
  const pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
  return (await Promise.all(pids.map(linuxProcessName))).filter((name) => name !== undefined);
}

const TASKLIST_TIMEOUT_MS = 5_000;

async function windowsProcesses(): Promise<string[]> {
  const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: TASKLIST_TIMEOUT_MS });
  return stdout.split(/\r?\n/).filter((line) => line.startsWith('"')).map((row) => row.slice(1, row.indexOf('"', 1)));
}

export const thisMachine: Machine = {
  platform: process.platform,
  get homeFolder() { return homedir(); },
  get userName() { return userInfo().username; },
  registryValue,
  documentsFolder,
  processes: () => (process.platform === 'win32' ? windowsProcesses() : linuxProcesses()),
};
