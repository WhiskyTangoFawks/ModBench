import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { WEBVIEW_STYLESHEET } from '../webviewStylesheet';

const outDir = mkdtemp(join(tmpdir(), 'modbench-webview-'));

afterAll(async () => rm(await outDir, { recursive: true, force: true }));

describe('the webview build', () => {
  it('emits the stylesheet and the page scripts that the hosts link', async () => {
    await build({
      configFile: resolve(__dirname, '../../../webview/vite.config.ts'),
      logLevel: 'silent',
      build: { outDir: await outDir, emptyOutDir: true },
    });

    expect(await readdir(join(await outDir, 'assets'))).toEqual(expect.arrayContaining([WEBVIEW_STYLESHEET, 'main.js', 'conflicts.js']));
  }, 60_000);
});
