import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { importSpecifiers, rootFiles, SRC } from './scanSource';
import { ACTIVATION_DECIDES_MESSAGE, ACTIVATION_DECIDES_SELECTORS } from '../../eslint-rules/activationDecides.mjs';


const ACTIVATION = 'extension.ts';
const WIRING = ['syncWiring.ts'];
const PORTS_THE_ROOT_IMPLEMENTS_OVER_THE_WINDOW_API = ['dialog.ts', 'reporter.ts', 'trash.ts', 'workspaceConfig.ts'];
const ACTIVATION_EXPORTS = ['activate', 'deactivate'];

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

let LINT_CONFIG_BLOCKS: unknown[] = [];
beforeAll(async () => { LINT_CONFIG_BLOCKS = await flatConfigBlocks(ESLINT_CONFIG); });

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

function activateReturnType(source: ts.SourceFile): string | undefined {
  const activate = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'activate');
  return activate && ts.isFunctionDeclaration(activate) ? activate.type?.getText(source) : undefined;
}

describe('the composition root builds each box, registers it with VS Code and decides nothing', () => {
  it('holds the activation file, its wiring and the ports it implements, and no other file', () => {
    expect(rootFiles().map((path) => basename(path)).sort()).toEqual([ACTIVATION, ...WIRING, ...PORTS_THE_ROOT_IMPLEMENTS_OVER_THE_WINDOW_API].sort());
  });

  it.each([ACTIVATION, ...WIRING])('the lint config applies the deciding selectors to %s', (file) => {
    expect(restrictedSyntaxOf(LINT_CONFIG_BLOCKS, file, ACTIVATION_DECIDES_MESSAGE)).toEqual(ACTIVATION_DECIDES_SELECTORS);
  });

  it('a config block that names the root files without the deciding selectors is not the rule', () => {
    const planted = [{ files: ['src/extension.ts'], rules: { 'no-restricted-syntax': ['error', { selector: 'IfStatement', message: 'other' }] } }];
    expect(restrictedSyntaxOf(planted, ACTIVATION, ACTIVATION_DECIDES_MESSAGE)).toEqual([]);
  });

  it.each(rootFiles().map((path) => basename(path)))('%s reaches the Editor only through its index and names no webview', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    expect(importSpecifiers(text, file).filter((specifier) => specifier.startsWith('./editor/'))).toEqual([]);
    expect(text).not.toMatch(/webview/i);
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
