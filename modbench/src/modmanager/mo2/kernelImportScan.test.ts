// ADR-0015 invariant 3: each MO2 file's format lives in its own kernel module under mo2/, self-contained
// enough that a kernel project could compile alone.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const KERNEL_DIR = __dirname; // src/modmanager/mo2/

function kernelFiles(): string[] {
  return readdirSync(KERNEL_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && extname(e.name) === '.ts' && !e.name.endsWith('.test.ts'))
    .map((e) => join(KERNEL_DIR, e.name));
}

function importSpecifiers(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// The codecs are pure, bytes in and bytes out (ADR-0015): a kernel module never opens a file
// itself, so these two are disallowed even though every other node: builtin is fine.
const FS_SPECIFIERS = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

// A relative specifier counts only if it resolves inside mo2/ itself — `../model` is one
// directory up, so it fails even though it starts with `.`.
function isAllowedSpecifier(spec: string, fromFile: string): boolean {
  if (FS_SPECIFIERS.has(spec)) return false;
  if (spec.startsWith('node:')) return true;
  if (!spec.startsWith('.')) return false;
  const resolved = resolve(dirname(fromFile), spec);
  return resolved === KERNEL_DIR || resolved.startsWith(KERNEL_DIR + '/');
}

function disallowedSpecifiers(path: string): string[] {
  return importSpecifiers(readFileSync(path, 'utf8'), path).filter((s) => !isAllowedSpecifier(s, path));
}

describe('mo2 kernel imports nothing outside mo2/', () => {
  it('scans a real body of kernel files', () => {
    expect(kernelFiles().length).toBeGreaterThan(5);
  });

  it('every production file under mo2/ imports only node: builtins and other mo2/ files', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of kernelFiles()) {
      const bad = disallowedSpecifiers(path);
      if (bad.length > 0) offenders[relative(KERNEL_DIR, path)] = bad;
    }
    expect(offenders).toEqual({});
  });

  // Rival this catches: a kernel module reaching to `../model` for a type instead of owning
  // it beside the codec that produces it. Calls `disallowedSpecifiers` on a real file, so
  // gutting that function cannot leave this test passing.
  it('flags an import planted upward out of mo2/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-kernel-import-scan-'));
    try {
      const planted = join(dir, 'planted.ts');
      await writeFile(planted, "import type { ModlistEntry } from '../model';\n");
      expect(disallowedSpecifiers(planted)).toEqual(['../model']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Rival this catches: a codec reaching into node:fs/promises to read the file itself instead
  // of taking its text as a parameter — the kernel is pure, bytes in and bytes out.
  it('flags a node:fs or node:fs/promises import planted in a kernel module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-kernel-import-scan-'));
    try {
      const planted = join(dir, 'planted.ts');
      await writeFile(planted, "import { readFile } from 'node:fs/promises';\nimport { existsSync } from 'node:fs';\n");
      expect(disallowedSpecifiers(planted)).toEqual(['node:fs/promises', 'node:fs']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
