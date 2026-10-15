import { cpSync, rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

rmSync('scripts', { recursive: true, force: true });
cpSync('../scripts/medit.py', 'scripts/medit.py');

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],   // provided by VS Code at runtime, never bundle
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],   // jsonc-parser's UMD entry requires its parts at run time, which a bundle lacks
  sourcemap: true,
  minify: false,
});
