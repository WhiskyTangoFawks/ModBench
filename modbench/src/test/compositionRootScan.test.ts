import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { Linter } from 'eslint';
import { importSpecifiers, rootFiles, SRC } from './scanSource';
import { ACTIVATION_DECIDES_MESSAGE, ACTIVATION_DECIDES_SELECTORS } from '../../eslint-rules/activationDecides.mjs';


const ACTIVATION = 'extension.ts';
const WIRING = ['syncWiring.ts'];
const PORTS_THE_ROOT_IMPLEMENTS_OVER_THE_WINDOW_API = ['dialog.ts', 'reporter.ts', 'trash.ts', 'workspaceConfig.ts'];
const ACTIVATION_EXPORTS = ['ActivateExports', 'activate', 'deactivate'];

const parse = (path: string, text = readFileSync(path, 'utf8')): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

function restrictedSyntaxApplied(config: unknown, message: string): string[] {
  if (typeof config !== 'object' || config === null || !('rules' in config)) return [];
  const { rules } = config;
  if (typeof rules !== 'object' || rules === null || !('no-restricted-syntax' in rules)) return [];
  const options: unknown = rules['no-restricted-syntax'];
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) =>
    (typeof option === 'object' && option !== null && 'message' in option && option.message === message
      && 'selector' in option && typeof option.selector === 'string' ? [option.selector] : []));
}

const ESLINT_CONFIG = join(SRC, '..', 'eslint.config.mjs');

async function flatConfigBlocks(path: string): Promise<unknown[]> {
  const loaded: unknown = await import(pathToFileURL(path).href);
  const blocks = typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : undefined;
  return Array.isArray(blocks) ? blocks as unknown[] : [];
}

const namesFile = (block: unknown, file: string): boolean =>
  typeof block === 'object' && block !== null && 'files' in block && Array.isArray(block.files) && block.files.includes(file);

function restrictedSyntaxOf(blocks: readonly unknown[], file: string, message: string): string[] {
  return blocks.filter((block) => namesFile(block, join('src', file).split(sep).join('/')))
    .map((block) => restrictedSyntaxApplied(block, message))
    .filter((selectors) => selectors.length > 0)
    .at(-1) ?? [];
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
    expect(rootFiles().map((path) => basename(path)).sort()).toEqual([ACTIVATION, ...WIRING, ...PORTS_THE_ROOT_IMPLEMENTS_OVER_THE_WINDOW_API].sort());
  });

  it.each([ACTIVATION, ...WIRING])('the lint config applies the deciding selectors to %s', async (file) => {
    expect(restrictedSyntaxOf(await flatConfigBlocks(ESLINT_CONFIG), file, ACTIVATION_DECIDES_MESSAGE)).toEqual(ACTIVATION_DECIDES_SELECTORS);
  });

  it('a config block that names the root files without the deciding selectors is not the rule', () => {
    const planted = [{ files: ['src/extension.ts'], rules: { 'no-restricted-syntax': ['error', { selector: 'IfStatement', message: 'other' }] } }];
    expect(restrictedSyntaxOf(planted, ACTIVATION, ACTIVATION_DECIDES_MESSAGE)).toEqual([]);
  });

  it.each(rootFiles().map((path) => basename(path)))('%s reaches the Editor only through its index and names no webview', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    expect(importSpecifiers(text, file).filter((specifier) => specifier.startsWith('./editor/'))).toEqual([]);
    expect(text).not.toMatch(/\bWebview/);
  });

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
