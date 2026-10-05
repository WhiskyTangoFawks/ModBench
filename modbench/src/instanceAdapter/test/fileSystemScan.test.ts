import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { tsFiles } from '../../test/tsFiles';

const SRC = join(__dirname, '..', '..');
const BOX = join('instanceAdapter') + sep;
const ADAPTER_PATH = join(SRC, 'instanceAdapter', 'files.ts');

const FS_SPECIFIERS = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);
const QUEUE_NAMES = new Set(['createWriteQueue', 'WriteQueue']);

const NOT_THE_INSTANCE = [
  join('extension.ts'),
];

const productionFiles = (dir: string): string[] =>
  tsFiles(dir, { exclude: ['generated', 'test'], tsx: false, includeTests: false });

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

function findOffenders(root: string, allowlist: readonly string[]): Record<string, string[]> {
  const offenders: Record<string, string[]> = {};
  for (const path of productionFiles(root)) {
    const rel = relative(root, path);
    if (rel.startsWith(BOX) || allowlist.includes(rel)) continue;
    const found = fsImportsIn(path);
    if (found.length > 0) offenders[rel] = found;
  }
  return offenders;
}

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

describe('no file outside the Instance adapter imports the file system to read the instance, the adapter being the one reader and writer of the instance', () => {
  it('covers the whole extension source tree', () => {
    expect(productionFiles(SRC).length).toBeGreaterThan(100);
  });

  it('reaches the commands, the views and the Instance box, not only one folder', () => {
    const scanned = productionFiles(SRC).map((p) => relative(SRC, p));
    expect(scanned).toContain(join('modlist', 'modlist.ts'));
    expect(scanned).toContain(join('instanceLoader', 'instance.ts'));
    expect(scanned).toContain(join('plugins', 'PluginsTreeProvider.ts'));
  });

  it('every production file outside the box names node:fs nowhere, bar the two listed', () => {
    expect(findOffenders(SRC, NOT_THE_INSTANCE)).toEqual({});
  });

  it('the walk itself catches a node:fs/promises import planted outside the box, in a real file under a real root so the walk is exercised too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-fs-import-scan-'));
    try {
      await writeFile(join(dir, 'planted.ts'), "import { readFile } from 'node:fs/promises';\n");
      expect(findOffenders(dir, [])).toEqual({ 'planted.ts': ['node:fs/promises'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the allowlist is exactly the file that opens storage of the extension’s own, the scripts folder under its storage path, and it imports the file system', () => {
    expect(NOT_THE_INSTANCE).toEqual(['extension.ts']);
    const listedFilesImportingNoFileSystem = NOT_THE_INSTANCE.filter((rel) => fsImportsIn(join(SRC, rel)).length === 0);
    expect(listedFilesImportingNoFileSystem).toEqual([]);
  });
});

describe('the keyed write queue is the adapter’s own, not exported', () => {
  it('files.ts exports neither the queue factory nor its type', () => {
    expect(queueNamesExportedBy(ADAPTER_PATH)).toEqual([]);
  });

  it('flags a module that exports createWriteQueue or WriteQueue, the queue factory un-privatized and exported again for reuse', async () => {
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
