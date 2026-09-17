// Planted against a real temporary tree, so no rival walker implementation collapses this to a
// vacuous pass.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsFiles } from './tsFiles';

let root: string | undefined;

function plant(relativePath: string): void {
  const path = join(root ?? '', relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function freshRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'medit-tsfiles-'));
  return root;
}

describe('tsFiles', () => {
  it('finds a .ts file nested under subdirectories', () => {
    const dir = freshRoot();
    plant(join('a', 'b', 'File.ts'));
    expect(tsFiles(dir)).toEqual([join(dir, 'a', 'b', 'File.ts')]);
  });

  it('includes .tsx and .test.ts by default', () => {
    const dir = freshRoot();
    plant('Component.tsx');
    plant('thing.test.ts');
    expect(tsFiles(dir).sort()).toEqual([join(dir, 'Component.tsx'), join(dir, 'thing.test.ts')].sort());
  });

  it('ignores a non-.ts file', () => {
    const dir = freshRoot();
    plant('notes.md');
    expect(tsFiles(dir)).toEqual([]);
  });

  it('always skips node_modules, even with no exclude option passed', () => {
    const dir = freshRoot();
    plant(join('node_modules', 'dep', 'index.ts'));
    plant('real.ts');
    expect(tsFiles(dir)).toEqual([join(dir, 'real.ts')]);
  });

  it('skips every directory named in the exclude option', () => {
    const dir = freshRoot();
    plant(join('generated', 'schema.ts'));
    plant('real.ts');
    expect(tsFiles(dir, { exclude: ['generated'] })).toEqual([join(dir, 'real.ts')]);
  });

  it('drops .tsx when tsx is false', () => {
    const dir = freshRoot();
    plant('Component.tsx');
    plant('logic.ts');
    expect(tsFiles(dir, { tsx: false })).toEqual([join(dir, 'logic.ts')]);
  });

  it('drops *.test.ts when includeTests is false', () => {
    const dir = freshRoot();
    plant('thing.test.ts');
    plant('thing.ts');
    expect(tsFiles(dir, { includeTests: false })).toEqual([join(dir, 'thing.ts')]);
  });
});
