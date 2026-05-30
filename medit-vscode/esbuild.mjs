import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],   // provided by VS Code at runtime, never bundle
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  minify: false,
});
