import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { bundledBackendPath, spawnPiped } from '../bundledBackend';

describe('bundledBackendPath', () => {
  it.each([
    ['win32', 'MEditService.Http.exe'],
    ['linux', 'MEditService.Http'],
  ] as const)('names the backend on %s %s', (platform, file) => {
    expect(bundledBackendPath(platform, join('x', 'out'))).toBe(join('x', 'backend', file));
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
    child.stdin.end();

    expect(await exited).toBe(7);
    expect(JSON.parse(out)).toEqual(['--ExitWhenStdinCloses', 'true']);
  });
});
