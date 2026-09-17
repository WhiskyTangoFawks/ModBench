// The kernel band's rule (docs/architecture/target-architecture.d2): "a kernel box references
// nothing". Each box is one composite project listing no references, so `tsc -b` is the sweep;
// this scan is the readable failure message beside it.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..');

// One directory per kernel box, as the zoom-out draws the Modbench kernel band.
const KERNEL_BOXES = ['mo2Codecs', 'tables', 'wire', 'ports'];

const boxRoot = (box: string): string => join(SRC, box);

// A box's production files: the box directory's own tree minus its tests, which live under
// `test/` and compile in the legacy project, not in the box's own.
function productionFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'test') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(path));
    else if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const kernelFiles = (): string[] => KERNEL_BOXES.flatMap((box) => productionFiles(boxRoot(box)));

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

// The kernel is pure, values in and values out: a kernel module never opens a file itself, so
// these are disallowed even though every other node: builtin is fine.
const FS_SPECIFIERS = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

// A relative specifier counts only if it resolves inside the box holding the file; a bare one
// is a package or `vscode`, neither of which a kernel box may name.
function isAllowedSpecifier(spec: string, fromFile: string, root: string): boolean {
  if (FS_SPECIFIERS.has(spec)) return false;
  if (spec.startsWith('node:')) return true;
  if (!spec.startsWith('.')) return false;
  const resolved = resolve(dirname(fromFile), spec);
  return resolved === root || resolved.startsWith(root + '/');
}

function disallowedSpecifiers(path: string, root: string): string[] {
  return importSpecifiers(readFileSync(path, 'utf8'), path).filter((s) => !isAllowedSpecifier(s, path, root));
}

function offenders(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const box of KERNEL_BOXES) {
    for (const path of productionFiles(boxRoot(box))) {
      const bad = disallowedSpecifiers(path, boxRoot(box));
      if (bad.length > 0) found[relative(SRC, path)] = bad;
    }
  }
  return found;
}

// A plant lands in a real temporary directory standing in for a box root and runs through the
// same `disallowedSpecifiers`, so gutting that function cannot leave these tests passing.
async function plantedSpecifiers(source: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'medit-kernel-import-scan-'));
  try {
    const planted = join(root, 'planted.ts');
    await writeFile(planted, source);
    return disallowedSpecifiers(planted, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('a kernel box references nothing', () => {
  it('names every box the kernel band draws', () => {
    expect(KERNEL_BOXES).toEqual(['mo2Codecs', 'tables', 'wire', 'ports']);
  });

  it('every box is a real directory holding production files', () => {
    for (const box of KERNEL_BOXES) {
      expect(existsSync(boxRoot(box))).toBe(true);
      expect(productionFiles(boxRoot(box)).length).toBeGreaterThan(0);
    }
  });

  it('scans a real body of kernel files', () => {
    expect(kernelFiles().length).toBeGreaterThan(10);
  });

  it('every production file in a kernel box imports only node: builtins and files in its own box', () => {
    expect(offenders()).toEqual({});
  });

  // Rival this catches: a kernel module reaching up for a type instead of owning it beside the
  // code that produces it.
  it('flags an import planted upward out of the box', async () => {
    expect(await plantedSpecifiers("import type { ModlistEntry } from '../model';\n")).toEqual(['../model']);
  });

  // Rival this catches: one kernel box reaching for another — the codecs taking `present` from
  // Ports, or the wire taking a game name from the tables.
  it('flags a sibling kernel box import planted in a kernel module', async () => {
    expect(await plantedSpecifiers("import { present } from '../ports/present';\n")).toEqual(['../ports/present']);
  });

  // Rival this catches: a kernel module taking a VS Code type, which drags the extension host
  // into a box the record panel also reads.
  it('flags a vscode import planted in a kernel module', async () => {
    expect(await plantedSpecifiers("import * as vscode from 'vscode';\n")).toEqual(['vscode']);
  });

  // Rival this catches: a codec reaching into node:fs/promises to read the file itself instead
  // of taking its text as a parameter.
  it('flags a node:fs or node:fs/promises import planted in a kernel module', async () => {
    expect(await plantedSpecifiers("import { readFile } from 'node:fs/promises';\nimport { existsSync } from 'node:fs';\n"))
      .toEqual(['node:fs/promises', 'node:fs']);
  });

  it('allows node:path, which a pure path function needs', async () => {
    expect(await plantedSpecifiers("import { join } from 'node:path';\n")).toEqual([]);
  });

  it('allows a file inside the same box', async () => {
    expect(await plantedSpecifiers("import { lineRanges } from './lineScan';\n")).toEqual([]);
  });
});
