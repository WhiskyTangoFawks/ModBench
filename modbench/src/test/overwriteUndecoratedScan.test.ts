// mods.md, A row, Overwrite: its icon carries the tint, and no decoration tints its label or the
// Explorer's `overwrite/`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tsFiles } from './tsFiles';

const SRC = join(__dirname, '..');

function overwriteDecorations(text: string): string[] {
  const registrations = [...text.matchAll(/registerFileDecorationProvider\(([^;]*)/g)]
    .map((m) => m[1] ?? '')
    .filter((argument) => /overwrite/i.test(argument));
  const providers = /implements\s+vscode\.FileDecorationProvider/.test(text) && /overwrite/i.test(text)
    ? ['a FileDecorationProvider naming overwrite']
    : [];
  return [...registrations, ...providers];
}

describe('nothing decorates Overwrite', () => {
  const sources = tsFiles(SRC, { exclude: ['generated'], includeTests: false });

  it('scans a real body of files, among them the ones that register decorations', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.filter((path) => readFileSync(path, 'utf8').includes('registerFileDecorationProvider(')).length)
      .toBeGreaterThan(1);
  });

  it.each(sources.map((path) => relative(SRC, path)))('%s', (relativePath) => {
    expect({ [relativePath]: overwriteDecorations(readFileSync(join(SRC, relativePath), 'utf8')) })
      .toEqual({ [relativePath]: [] });
  });

  // The rivals: the retired provider class, and its registration under any name.
  it('flags a provider over overwrite/ and its registration', () => {
    expect(overwriteDecorations(
      'export class OverwriteDecorationProvider implements vscode.FileDecorationProvider {}',
    )).toHaveLength(1);
    expect(overwriteDecorations(
      'own(vscode.window.registerFileDecorationProvider(new TintProvider(instance.value.paths.overwriteDir)));',
    )).toHaveLength(1);
    expect(overwriteDecorations(
      'own(vscode.window.registerFileDecorationProvider(new HiddenDownloadDecorationProvider(dir)));',
    )).toEqual([]);
  });
});
