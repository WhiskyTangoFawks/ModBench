import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';

const SRC = join(__dirname, '..');

const isTestSupport = (relPath: string): boolean =>
  relPath.split(/[\\/]/).some((segment) => segment === 'test' || segment === 'integration') || relPath.includes('.test.');

function erasedAsTypes(clause: ts.ImportClause | ts.NamedExportBindings | undefined, declarationIsTypeOnly: boolean): boolean {
  if (declarationIsTypeOnly) return true;
  if (clause === undefined) return false;
  if (ts.isImportClause(clause)) {
    if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
    if (clause.name !== undefined) return false;
    const bindings = clause.namedBindings;
    return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0
      && bindings.elements.every((element) => element.isTypeOnly);
  }
  return ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

function resolved(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier);
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) => existsSync(candidate));
}

function modulesEvaluatedFirst(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (erasedAsTypes(statement.importClause, false)) return [];
      return [resolved(path, statement.moduleSpecifier.text)].filter((target) => target !== undefined);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (erasedAsTypes(statement.exportClause, statement.isTypeOnly)) return [];
      return [resolved(path, statement.moduleSpecifier.text)].filter((target) => target !== undefined);
    }
    return [];
  });
}

function importCycles(root: string): string[][] {
  const files = tsFiles(root, { exclude: ['generated'] }).filter((path) => !isTestSupport(relative(root, path)));
  const graph = new Map(files.map((path) => [path, modulesEvaluatedFirst(path)]));
  const cycles: string[][] = [];
  const done = new Set<string>();
  const visit = (path: string, trail: string[]): void => {
    const at = trail.indexOf(path);
    if (at !== -1) {
      cycles.push(trail.slice(at).map((file) => relative(root, file)));
      return;
    }
    if (done.has(path)) return;
    for (const target of graph.get(path) ?? []) visit(target, [...trail, path]);
    done.add(path);
  };
  for (const path of files) visit(path, []);
  return cycles;
}

async function plantedTree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'medit-import-cycle-scan-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

describe('no module of modbench imports itself through others, so none reads an export before the module defining it has run', () => {
  it('scans clean', () => {
    expect(importCycles(SRC)).toEqual([]);
  });

  it('catches a planted cycle, and passes one that only a type-only import closes, which compiles away', async () => {
    const dir = await plantedTree({
      'a.ts': "import { b } from './b';\nexport const a = b;\n",
      'b.ts': "import { a } from './a';\nexport const b = () => a;\n",
      'c.ts': "import type { D } from './d';\nexport const c = 1;\nexport type C = D;\n",
      'd.ts': "import { c } from './c';\nexport type D = typeof c;\n",
    });
    try {
      expect(importCycles(dir)).toEqual([['a.ts', 'b.ts']]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
