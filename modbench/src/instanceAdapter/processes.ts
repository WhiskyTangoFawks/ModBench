import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { errnoCode } from '../ports/errno';

// Linux keeps a process's name in 15 characters, and Wine names a process for its program file.
const LINUX_NAME_LENGTH = 15;

async function linuxProcessName(pid: string): Promise<string | undefined> {
  try {
    return (await readFile(`/proc/${pid}/comm`, 'utf8')).trimEnd();
  } catch (err) {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ESRCH') return undefined;
    throw err;
  }
}

async function runningOnLinux(fileName: string): Promise<boolean> {
  const pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
  const names = await Promise.all(pids.map(linuxProcessName));
  return names.includes(fileName.slice(0, LINUX_NAME_LENGTH));
}

const TASKLIST_TIMEOUT_MS = 5_000;

const isCsvRow = (line: string): boolean => line.startsWith('"');

async function runningOnWindows(fileName: string): Promise<boolean> {
  const { stdout } = await promisify(execFile)(
    'tasklist', ['/FI', `IMAGENAME eq ${fileName}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: TASKLIST_TIMEOUT_MS },
  );
  return stdout.split(/\r?\n/).some(isCsvRow);
}

/** Whether a process runs the program file named `fileName`. */
export const programRunning = (fileName: string): Promise<boolean> =>
  (process.platform === 'win32' ? runningOnWindows(fileName) : runningOnLinux(fileName));
