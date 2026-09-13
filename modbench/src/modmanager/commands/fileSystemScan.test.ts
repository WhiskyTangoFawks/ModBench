// target-architecture.d2: MO2 files is the one reader and writer of the instance. A command
// splices its own codec and puts through it, never through node:fs itself.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import ts from 'typescript';

const COMMANDS_DIR = __dirname; // src/modmanager/commands/
const ADAPTER_PATH = join(COMMANDS_DIR, '..', 'mo2Files.ts');
const FS_SPECIFIERS = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);
const QUEUE_NAMES = new Set(['createWriteQueue', 'WriteQueue']);

function commandModules(): string[] {
  return readdirSync(COMMANDS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && extname(e.name) === '.ts' && !e.name.endsWith('.test.ts'))
    .map((e) => join(COMMANDS_DIR, e.name));
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

// Every top-level declared or re-exported name, whether or not `export` sits on its own line.
function exportedNames(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const hasExport = (n: ts.Node): boolean =>
      ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(node) && node.name && hasExport(node)) found.push(node.name.text);
    if (ts.isInterfaceDeclaration(node) && hasExport(node)) found.push(node.name.text);
    if (ts.isVariableStatement(node) && hasExport(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) found.push(decl.name.text);
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) found.push(el.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function queueNamesExportedBy(path: string): string[] {
  return exportedNames(readFileSync(path, 'utf8'), path).filter((name) => QUEUE_NAMES.has(name));
}

describe('no command imports the file system', () => {
  it('scans a real body of command modules', () => {
    expect(commandModules().length).toBeGreaterThan(3);
  });

  it('every production file under commands/ imports node:fs from nowhere', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of commandModules()) {
      const found = fsImportsIn(path);
      if (found.length > 0) offenders[path] = found;
    }
    expect(offenders).toEqual({});
  });

  // Rival this catches: a command reaching back into node:fs/promises instead of MO2 files.
  it('flags a module that imports node:fs/promises', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-fs-import-scan-'));
    try {
      const planted = join(dir, 'planted.ts');
      await writeFile(planted, "import { readFile } from 'node:fs/promises';\n");
      expect(fsImportsIn(planted)).toEqual(['node:fs/promises']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the keyed write queue is the adapter’s own, not exported', () => {
  it('mo2Files.ts exports neither the queue factory nor its type', () => {
    expect(queueNamesExportedBy(ADAPTER_PATH)).toEqual([]);
  });

  // Rival this catches: the queue factory un-privatized and exported again for reuse.
  it('flags a module that exports createWriteQueue or WriteQueue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-queue-export-scan-'));
    try {
      const planted = join(dir, 'planted.ts');
      await writeFile(
        planted,
        'export interface WriteQueue { (key: string): void }\n' +
          'export function createWriteQueue(): WriteQueue { return (() => {}) as WriteQueue; }\n',
      );
      expect(queueNamesExportedBy(planted).sort()).toEqual(['WriteQueue', 'createWriteQueue'].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
