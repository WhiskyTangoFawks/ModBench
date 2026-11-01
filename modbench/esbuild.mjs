import { cpSync, rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

rmSync('scripts', { recursive: true, force: true });
cpSync('../scripts/medit.py', 'scripts/medit.py');
cpSync('../scripts/default', 'scripts/default', { recursive: true, filter: (source) => !source.endsWith('__pycache__') });

rmSync('schemas', { recursive: true, force: true });
cpSync('../spec/formats', 'schemas', { recursive: true, filter: (source) => !source.endsWith('.md') });

// The FOMOD engine's add-on for one platform: this machine's, unless package.mjs names a target's.
const fomodTarget = process.env.FOMOD_ENGINE_TARGET ?? `${process.platform}-${process.arch}`;
rmSync('out/fomodEngine', { recursive: true, force: true });
cpSync(`node_modules/@nexusmods/fomod-installer-native/prebuilds/${fomodTarget}`, 'out/fomodEngine', { recursive: true });

const shared = { bundle: true, format: 'cjs', platform: 'node', sourcemap: true, minify: false };

await esbuild.build({
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  external: ['vscode'],   // provided by VS Code at runtime, never bundle
  mainFields: ['module', 'main'],   // jsonc-parser's UMD entry requires its parts at run time, which a bundle lacks
});

await esbuild.build({
  ...shared,
  entryPoints: ['src/instanceAdapter/fomodInstaller/engineProcess.ts'],
  outfile: 'out/fomodEngine.js',
});
