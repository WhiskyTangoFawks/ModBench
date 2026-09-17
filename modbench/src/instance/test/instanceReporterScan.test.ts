// ADR-0015: the Instance keeps a read failure in its value for a subscriber to render, and
// reports nothing itself — that channel belongs to a view wrapping it (instanceFirstRead.ts).
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

describe('the Instance imports no reporter', () => {
  it('instance.ts names no reporter module in its imports', () => {
    expect(reporterImportsIn(INSTANCE_PATH)).toEqual([]);
  });

  // Rival this catches: a recompute failure reported straight from the Instance instead of
  // being left in `readFailure` for a subscriber (or instanceFirstRead.ts) to surface. Calls
  // `reporterImportsIn` on a real file, so gutting that function cannot leave this test passing.
  it('flags a reporter import planted in a real file', async () => {
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
