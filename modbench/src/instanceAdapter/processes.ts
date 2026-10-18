// Whether a program runs on this machine, asked of each platform's own process table.

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { errnoCode } from './errno';

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

// tasklist matches the image name without case, and prints a line in the system's language when none runs.
async function runningOnWindows(fileName: string): Promise<boolean> {
  const { stdout } = await promisify(execFile)('tasklist', ['/FI', `IMAGENAME eq ${fileName}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
  return stdout.split(/\r?\n/).some((line) => line.startsWith('"'));
}

/** Whether a process runs the program file named `fileName`. */
export const programRunning = (fileName: string): Promise<boolean> =>
  (process.platform === 'win32' ? runningOnWindows(fileName) : runningOnLinux(fileName));
