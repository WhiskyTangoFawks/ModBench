// ADR-0015: MO2 files is the one reader of the instance. Every other file beside the Instance
// asks it, rather than opening node:fs itself.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';

const FOLDER = __dirname; // src/modmanager/

// The adapter itself, plus two known exceptions this scan leaves alone: detectMo2Instance.ts is
// a synchronous composition-root gate that runs before an Instance exists, and deployer.ts is a
// separate driven adapter over Game Data/, not the instance.
const EXCEPTIONS = new Set(['mo2Files.ts', 'detectMo2Instance.ts', 'deployer.ts']);

const FS_SPECIFIERS = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

function folderFiles(): string[] {
  return readdirSync(FOLDER, { withFileTypes: true })
    .filter((e) => e.isFile() && extname(e.name) === '.ts' && !e.name.endsWith('.test.ts'))
    .filter((e) => !EXCEPTIONS.has(e.name))
    .map((e) => join(FOLDER, e.name));
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

function fsImportsIn(path: string): string[] {
  return importSpecifiers(readFileSync(path, 'utf8'), path).filter((spec) => FS_SPECIFIERS.has(spec));
}

describe('no file in the Instance\'s folder imports the file system outside the adapter', () => {
  it('scans a real body of files', () => {
    expect(folderFiles().length).toBeGreaterThan(5);
  });

  it('every production file here, other than mo2Files.ts and its two listed exceptions, imports no node:fs', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of folderFiles()) {
      const found = fsImportsIn(path);
      if (found.length > 0) offenders[relative(FOLDER, path)] = found;
    }
    expect(offenders).toEqual({});
  });

  // Rival this catches: a helper reaching back into node:fs/promises instead of MO2 files.
  it('flags a node:fs/promises import planted in a real file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-instance-folder-fs-scan-'));
    try {
      const planted = join(dir, 'planted.ts');
      await writeFile(planted, "import { readFile } from 'node:fs/promises';\n");
      expect(fsImportsIn(planted)).toEqual(['node:fs/promises']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
