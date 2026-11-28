import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine } from '../instanceAdapter/instanceAdapter';

const NO_MACHINE: Machine = {
  platform: process.platform,
  homeFolder: join(tmpdir(), 'modbench-no-home'),
  userName: 'user',
  registryValue: (key, name) => Promise.reject(new Error(`${key} holds no ${name}`)),
  documentsFolder: () => Promise.reject(new Error('no known folder')),
  processes: () => Promise.resolve([]),
};

/** The machine as a test fixes it: by default no Steam, no known folder and no process running, with `machine` in place, a getter
 *  of it asked at each read. */
export const fakeMachine = (machine: Partial<Machine> = {}): Machine =>
  Object.defineProperties({ ...NO_MACHINE }, Object.getOwnPropertyDescriptors(machine));
