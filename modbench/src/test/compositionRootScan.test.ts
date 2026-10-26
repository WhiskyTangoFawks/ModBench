import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import ts from 'typescript';
import { importSpecifiers, rootFiles, SRC } from './scanSource';
import { ACTIVATION_DECIDES_MESSAGE, ACTIVATION_DECIDES_SELECTORS } from '../../eslint-rules/activationDecides.mjs';


const ACTIVATION = 'extension.ts';
const WIRING = ['syncWiring.ts'];
const PORTS_THE_ROOT_IMPLEMENTS_OVER_THE_WINDOW_API = ['dialog.ts', 'hostGit.ts', 'tasks.ts', 'trash.ts', 'workspaceConfig.ts'];
const ACTIVATION_EXPORTS = ['activate', 'deactivate'];

const parse = (path: string, text = readFileSync(path, 'utf8')): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

function restrictedSyntaxOptions(config: unknown): unknown[] | undefined {
  if (typeof config !== 'object' || config === null || !('rules' in config)) return undefined;
  const { rules } = config;
  if (typeof rules !== 'object' || rules === null || !('no-restricted-syntax' in rules)) return undefined;
  const options: unknown = rules['no-restricted-syntax'];
  return Array.isArray(options) ? options as unknown[] : undefined;
}

function restrictedSyntaxApplied(options: readonly unknown[], message: string): string[] {
  return options.flatMap((option: unknown) =>
    (typeof option === 'object' && option !== null && 'message' in option && option.message === message
      && 'selector' in option && typeof option.selector === 'string' ? [option.selector] : []));
}

const MODBENCH = join(SRC, '..');
const ESLINT_CONFIG = join(MODBENCH, 'eslint.config.mjs');

let LINT: ESLint;
const LOADING_THE_WHOLE_LINT_TOOLCHAIN_MS = 60_000;
beforeAll(() => { LINT = new ESLint({ cwd: MODBENCH, overrideConfigFile: ESLINT_CONFIG }); }, LOADING_THE_WHOLE_LINT_TOOLCHAIN_MS);

async function decidingSelectorsApplied(lint: ESLint, file: string): Promise<string[]> {
  const options = restrictedSyntaxOptions(await lint.calculateConfigForFile(join(SRC, file)));
  return options === undefined ? [] : restrictedSyntaxApplied(options, ACTIVATION_DECIDES_MESSAGE);
}

const plantedLint = (...blocks: Linter.Config[]): ESLint => new ESLint({ cwd: MODBENCH, overrideConfigFile: true, overrideConfig: blocks });

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

function activateReturnType(source: ts.SourceFile): string | undefined {
  const activate = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'activate');
  return activate && ts.isFunctionDeclaration(activate) ? activate.type?.getText(source) : undefined;
}

describe('the composition root builds each box, registers it with VS Code and decides nothing', () => {
  it('holds the activation file, its wiring and the ports it implements, and no other file', () => {
    expect(rootFiles().map((path) => basename(path)).sort()).toEqual([ACTIVATION, ...WIRING, ...PORTS_THE_ROOT_IMPLEMENTS_OVER_THE_WINDOW_API].sort());
  });

  it.each(rootFiles().map((path) => basename(path)))('the lint config applies the deciding selectors to %s', async (file) => {
    expect(await decidingSelectorsApplied(LINT, file)).toEqual(ACTIVATION_DECIDES_SELECTORS);
  });

  it('a config block that names a root file without the deciding selectors is not the rule', async () => {
    const planted = plantedLint({ files: ['src/*.ts'], rules: { 'no-restricted-syntax': ['error', { selector: 'IfStatement', message: 'other' }] } });
    expect(await decidingSelectorsApplied(planted, ACTIVATION)).toEqual([]);
  });

  it('a later block that covers a root file and drops the deciding selectors is the one that applies', async () => {
    const deciding = { files: ['src/*.ts'], rules: { 'no-restricted-syntax': ['error', { selector: 'IfStatement', message: ACTIVATION_DECIDES_MESSAGE }] } } satisfies Linter.Config;
    const later = { files: ['src/**/*.ts'], rules: { 'no-restricted-syntax': ['error', { selector: 'Foo', message: 'other' }] } } satisfies Linter.Config;
    expect(await decidingSelectorsApplied(plantedLint(deciding, later), ACTIVATION)).toEqual([]);
  });

  it.each(rootFiles().map((path) => basename(path)))('%s reaches the Editor only through its index and names no webview', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    expect(importSpecifiers(text, file).filter((specifier) => specifier.startsWith('./editor/'))).toEqual([]);
    expect(text).not.toMatch(/webview/i);
  });

  it.each(rootFiles().map((path) => basename(path)))('%s reaches Plugins only through its index', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    expect(importSpecifiers(text, file).filter((specifier) => specifier.startsWith('./plugins/'))).toEqual([]);
  });

  it('exports nothing from the activation file but what VS Code takes', () => {
    expect(exportedNames(parse(join(SRC, ACTIVATION)))).toEqual(ACTIVATION_EXPORTS);
  });

  it('activation returns nothing', () => {
    expect(activateReturnType(parse(join(SRC, ACTIVATION)))).toBe('void');
  });

  it('a second export from the activation file is named', () => {
    expect(exportedNames(parse('planted.ts', 'export function activate() {}\nexport const decide = 1;\n'))).toEqual(['activate', 'decide']);
  });
});
