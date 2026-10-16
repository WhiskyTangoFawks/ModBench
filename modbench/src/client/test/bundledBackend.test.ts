import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { bundledBackendPath, spawnPiped } from '../bundledBackend';

describe('bundledBackendPath', () => {
  it('names the .exe on win32', () => {
    expect(bundledBackendPath('win32', join('x', 'out'))).toBe(join('x', 'backend', 'MEditService.Http.exe'));
  });

  it('names the bare binary on linux', () => {
    expect(bundledBackendPath('linux', join('x', 'out'))).toBe(join('x', 'backend', 'MEditService.Http'));
  });
});

describe('spawnPiped', () => {
  it('hands the backend a stdin it can watch, and asks it to exit when that stdin closes', async () => {
    const reportArgsAndWaitForStdinToEnd =
      "process.stdout.write(JSON.stringify(process.argv.slice(-2))); process.stdin.on('end', () => process.exit(7)); process.stdin.resume();";
    const child = spawnPiped(process.execPath, ['-e', reportArgsAndWaitForStdinToEnd, '--']);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(child.stdin).not.toBeNull();
    child.stdin?.end();

    expect(await exited).toBe(7);
    expect(JSON.parse(out)).toEqual(['--ExitWhenStdinCloses', 'true']);
  });
});
