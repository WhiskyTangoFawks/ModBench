import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const INSTANCE_PATH = join(__dirname, '..', 'instance.ts');

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

function reporterImportsIn(path: string): string[] {
  return importSpecifiers(readFileSync(path, 'utf8'), path).filter((spec) => /\breporter$/.test(spec));
}

describe('the Instance imports no reporter, leaving a read failure in its value for a subscriber to render rather than raising a notification', () => {
  it('instance.ts names no reporter module in its imports', () => {
    expect(reporterImportsIn(INSTANCE_PATH)).toEqual([]);
  });

  it('flags a reporter import planted in a real file, so a scan that finds nothing in any file cannot leave the check passing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-instance-reporter-scan-'));
    try {
      const planted = join(dir, 'planted.ts');
      await writeFile(planted, "import type { Reporter } from '../ports/reporter';\n");
      expect(reporterImportsIn(planted)).toEqual(['../ports/reporter']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
