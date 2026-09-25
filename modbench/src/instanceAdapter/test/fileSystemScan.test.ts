// target-architecture.d2: the Instance adapter is the one reader and writer of the instance. Every
// other module asks it, and the two files below open the extension's own storage, never the
// instance.
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

// Storage of the extension's own, which no MO2 instance holds: the scripts folder under the
// extension's storage path, and the temp file an external editor opens.
const NOT_THE_INSTANCE = [
  join('extension.ts'),
  join('editor', 'extendedFieldEditor.ts'),
];

// Production files only: a test builds a real MO2 tree of its own and opens it directly.
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

// Shared by the production assertion and the rival below, so a broken walk fails both the same
// way, not just the matcher.
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

describe('no file outside the Instance adapter imports the file system to read the instance', () => {
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

  // Rival: a command, a view or a derivation reaching back into node:fs/promises rather than
  // asking the Instance adapter. Planted in a real file under a real root, so the walk is
  // exercised too.
  it('the walk itself catches a node:fs/promises import planted outside the box', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-fs-import-scan-'));
    try {
      await writeFile(join(dir, 'planted.ts'), "import { readFile } from 'node:fs/promises';\n");
      expect(findOffenders(dir, [])).toEqual({ 'planted.ts': ['node:fs/promises'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Rival: the allowlist growing silently. Each entry is one of the extension's own storage
  // paths, and each really does open a file.
  it('the allowlist is exactly the two files that open storage of the extension’s own', () => {
    expect(NOT_THE_INSTANCE).toEqual([
      'extension.ts', join('editor', 'extendedFieldEditor.ts'),
    ]);
    for (const rel of NOT_THE_INSTANCE) {
      expect(fsImportsIn(join(SRC, rel)).length).toBeGreaterThan(0);
    }
  });
});

describe('the keyed write queue is the adapter’s own, not exported', () => {
  it('files.ts exports neither the queue factory nor its type', () => {
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
