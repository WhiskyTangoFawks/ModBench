// ADR-0047 §7: each MO2 file's format lives in its own kernel module under mo2/, self-contained
// enough that a kernel project could compile alone.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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

// A relative specifier counts only if it resolves inside mo2/ itself — `../model` is one
// directory up, so it fails even though it starts with `.`.
function isAllowedSpecifier(spec: string, fromFile: string): boolean {
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

  // Rival this catches: a kernel module reaching to `../model` (or any other sibling context)
  // for a type instead of owning it beside the codec that produces it.
  it('flags an import planted upward out of mo2/', () => {
    const planted = "import type { ModlistEntry } from '../model';\n";
    expect(importSpecifiers(planted, join(KERNEL_DIR, 'planted.ts')).filter(
      (s) => !isAllowedSpecifier(s, join(KERNEL_DIR, 'planted.ts')),
    )).toEqual(['../model']);
  });
});
