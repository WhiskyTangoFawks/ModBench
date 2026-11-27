import type { Machine } from './instanceAdapter';

// Linux keeps a process's name in 15 characters, and Wine names a process for its program file.
const LINUX_NAME_LENGTH = 15;

/** Whether a process runs the program file named `fileName`. */
export async function programRunning(machine: Machine, fileName: string): Promise<boolean> {
  const names = await machine.processes();
  if (machine.platform !== 'win32') return names.includes(fileName.slice(0, LINUX_NAME_LENGTH));
  const wanted = fileName.toLowerCase();
  return names.some((name) => name.toLowerCase() === wanted);
}
