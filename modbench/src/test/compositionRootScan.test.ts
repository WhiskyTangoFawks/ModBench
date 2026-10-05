import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..');

const ACTIVATION = 'extension.ts';
const WIRING = ['syncWiring.ts'];
const PORTS_THE_ROOT_IMPLEMENTS_OVER_THE_WINDOW_API = ['dialog.ts', 'reporter.ts', 'trash.ts', 'workspaceConfig.ts'];
const ACTIVATION_EXPORTS = ['ActivateExports', 'activate', 'deactivate'];

const rootFiles = (): string[] =>
  readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();

const parse = (path: string, text = readFileSync(path, 'utf8')): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

const BRANCHING = [
  ts.isIfStatement, ts.isSwitchStatement, ts.isForStatement, ts.isForInStatement, ts.isForOfStatement,
  ts.isWhileStatement, ts.isDoStatement, ts.isTryStatement,
];

function decisions(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (BRANCHING.some((is) => is(node))) {
      found.push(`${ts.SyntaxKind[node.kind]}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function exportedNames(source: ts.SourceFile): string[] {
  return source.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) return ['<re-export>'];
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return [];
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((d) => d.name.getText(source));
    const named = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
    return [named ? statement.name?.getText(source) ?? '<anonymous>' : '<anonymous>'];
  }).sort();
}

describe('the composition root builds each box, registers it with VS Code and decides nothing', () => {
  it('holds the activation file, its wiring and the ports it implements, and no other file', () => {
    expect(rootFiles()).toEqual([ACTIVATION, ...WIRING, ...PORTS_THE_ROOT_IMPLEMENTS_OVER_THE_WINDOW_API].sort());
  });

  it.each([ACTIVATION, ...WIRING])('%s branches on nothing', (file) => {
    expect(decisions(parse(join(SRC, file)))).toEqual([]);
  });

  it('exports nothing from the activation file but what VS Code and the integration tests take', () => {
    expect(exportedNames(parse(join(SRC, ACTIVATION)))).toEqual(ACTIVATION_EXPORTS);
  });

  it('reads the activation file as a body of construction', () => {
    expect(readFileSync(join(SRC, ACTIVATION), 'utf8').split('\n').length).toBeGreaterThan(300);
  });

  describe('a plant is caught', () => {
    const plant = (text: string) => decisions(parse('planted.ts', text));

    it.each([
      ['an if', 'function f(x: number) { if (x > 1) return 1; return 2; }'],
      ['a switch', 'function f(x: number) { switch (x) { case 1: return 1; default: return 2; } }'],
      ['a loop', 'function f(xs: number[]) { for (const x of xs) void x; }'],
      ['a while', 'function f() { while (true) break; }'],
      ['a try', 'function f() { try { g(); } catch { return; } }'],
    ])('%s', (_name, text) => {
      expect(plant(text)).not.toEqual([]);
    });

    it('and construction beside it is not', () => {
      expect(plant('const x = a?.b ?? c; own(register(x)); const y = [1].map((n) => n);')).toEqual([]);
    });

    it('a second export from the activation file is named', () => {
      expect(exportedNames(parse('planted.ts', 'export function activate() {}\nexport const decide = 1;\n'))).toEqual(['activate', 'decide']);
    });
  });
});
