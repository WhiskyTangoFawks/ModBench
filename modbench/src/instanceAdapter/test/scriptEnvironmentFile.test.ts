import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceAdapter } from '../instanceAdapter';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { instanceOnDisk } from './instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const scriptEnvironmentFile = (root: string, setting: () => string | undefined): InstanceAdapter['scriptEnvironmentFile'] =>
  adapterOver(root, { get pythonEnvFile() { return setting(); } }).scriptEnvironmentFile;

describe('the file the Python tooling reads its environment from', () => {
  let root: string;
  beforeEach(async () => {
    root = await instanceOnDisk();
    await mkdir(join(root, 'config'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('is .env at the instance root when python.envFile names none, and reads empty before it exists', async () => {
    const file = scriptEnvironmentFile(root, () => undefined);
    expect(await file.read()).toBe('');

    await file.write('A=1\n');

    expect(await readFile(join(root, '.env'), 'utf8')).toBe('A=1\n');
    expect(await file.read()).toBe('A=1\n');
  });

  it.each([
    ['a ${workspaceFolder} path', '${workspaceFolder}/config/py.env'],
    ['a path from the instance root', 'config/py.env'],
  ])('is the file python.envFile names as %s', async (_, setting) => {
    await scriptEnvironmentFile(root, () => setting).write('B=2\n');

    expect(await readFile(join(root, 'config', 'py.env'), 'utf8')).toBe('B=2\n');
  });

  it('is the file python.envFile names as an absolute path', async () => {
    const absolute = join(root, 'config', 'abs.env');
    await scriptEnvironmentFile(root, () => absolute).write('C=3\n');

    expect(await readFile(absolute, 'utf8')).toBe('C=3\n');
  });

  it('follows the setting as it changes', async () => {
    let setting: string | undefined = 'config/one.env';
    const file = scriptEnvironmentFile(root, () => setting);
    await writeFile(join(root, 'config', 'two.env'), 'D=4\n');

    setting = 'config/two.env';

    expect(await file.read()).toBe('D=4\n');
  });

  it('fails to read what is not a missing file', async () => {
    await expect(scriptEnvironmentFile(root, () => 'config').read()).rejects.toThrow();
  });
});
