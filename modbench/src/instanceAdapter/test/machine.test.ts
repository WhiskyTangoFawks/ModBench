import { describe, it, expect, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { thisMachine } from '../openInstance';

vi.mock('vscode', () => fakeVscodeModule());

const UTF8_FIRST = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';
const printed = vi.hoisted(() => ({ documents: '', reg: '' }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const run = promisify(actual.execFile);
  const asked = (file: string, args: readonly string[], options: object) => {
    if (file === 'powershell') {
      return Promise.resolve({ stdout: Buffer.from(`${printed.documents}\r\n`, args.at(-1)?.startsWith(UTF8_FIRST) ? 'utf8' : 'latin1'), stderr: Buffer.alloc(0) });
    }
    return file === 'reg' ? Promise.resolve({ stdout: printed.reg, stderr: '' }) : run(file, args, options);
  };
  return { ...actual, execFile: Object.assign(actual.execFile.bind(undefined), { [promisify.custom]: asked }) };
});

describe('the machine Modbench runs on', () => {
  it('reads a non-ASCII Documents path as UTF-8, having told PowerShell to write it so', async () => {
    printed.documents = 'C:\\Users\\José\\Документы';

    expect(await thisMachine.documentsFolder()).toBe('C:\\Users\\José\\Документы');
  });

  it.each([
    ['the string reg prints for it', '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n\r\n', 'c:/program files (x86)/steam'],
    ['none when reg prints it as no string', '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_DWORD    0x1\r\n\r\n', undefined],
  ])('answers a registry value: %s', async (_case, reg, value) => {
    printed.reg = reg;

    expect(await thisMachine.registryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath')).toBe(value);
  });
});
