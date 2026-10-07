import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { SRC } from './scanSource';

const ADAPTER_PATH = join(SRC, 'instanceAdapter', 'files.ts');

const QUEUE_NAMES = new Set(['createWriteQueue', 'WriteQueue']);

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
