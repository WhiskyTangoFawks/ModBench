import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ESLint, Linter } from 'eslint';
import { ACTIVATION_DECIDES_MESSAGE, ACTIVATION_DECIDES_SELECTORS } from '../../eslint-rules/activationDecides.mjs';

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

  it.each([ACTIVATION, ...WIRING])('lint holds %s to deciding nothing', async (file) => {
    const [result] = await new ESLint({ cwd: join(SRC, '..') }).lintText('export const planted = (a: number) => (a ? 1 : 2);\n', { filePath: join(SRC, file) });
    expect(result?.messages.filter((message) => message.ruleId === 'no-restricted-syntax').map((message) => message.message))
      .toEqual([ACTIVATION_DECIDES_MESSAGE]);
  }, 60_000);

  it('exports nothing from the activation file but what VS Code and the integration tests take', () => {
    expect(exportedNames(parse(join(SRC, ACTIVATION)))).toEqual(ACTIVATION_EXPORTS);
  });

  describe('a plant is caught', () => {
    const lint = (code: string) => new Linter().verify(code, {
      rules: {
        'no-restricted-syntax': ['error', ...ACTIVATION_DECIDES_SELECTORS.map((selector) => ({ selector, message: ACTIVATION_DECIDES_MESSAGE }))],
      },
    }).map((message) => message.message);

    it.each([
      ['an if', 'function f(x) { if (x > 1) return 1; return 2; }'],
      ['a switch', 'function f(x) { switch (x) { case 1: return 1; default: return 2; } }'],
      ['a loop', 'function f(xs) { for (const x of xs) void x; }'],
      ['a while', 'function f() { while (true) break; }'],
      ['a try', 'function f() { try { g(); } catch { return; } }'],
      ['a ternary', 'const x = a ? 1 : 2;'],
      ['a default', 'const x = a ?? 1;'],
      ['an and', 'const x = a && b;'],
      ['an or', 'const x = a || b;'],
      ['a default assignment', 'x ??= 1;'],
      ['an or assignment', 'x ||= 1;'],
      ['an and assignment', 'x &&= 1;'],
    ])('%s', (_name, code) => {
      expect(lint(code)).toEqual([ACTIVATION_DECIDES_MESSAGE]);
    });

    it('and construction beside it is not', () => {
      expect(lint('const x = a?.b; own(register(x)); const y = [1].map((n) => n);')).toEqual([]);
    });

    it('a second export from the activation file is named', () => {
      expect(exportedNames(parse('planted.ts', 'export function activate() {}\nexport const decide = 1;\n'))).toEqual(['activate', 'decide']);
    });
  });
});
