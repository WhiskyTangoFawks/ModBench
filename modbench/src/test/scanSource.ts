import { basename, join, relative } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';

export const SRC = join(__dirname, '..');
export const WEBVIEW_SRC = join(SRC, '..', 'webview', 'src');
export const SOURCE_ROOTS = [SRC, WEBVIEW_SRC];

export const MO2_NAMES = {
  anywhere: [/mo2/i, /modorganizer/i, /\bMod Organizer\b/i],
  files: ['modlist.txt', 'ModOrganizer.ini', 'meta.ini', '.mohidden', '.meta'],
  directories: ['profiles', 'mods', 'overwrite', 'downloads'],
} as const;

export const MO2_CONSTRUCTION = { file: 'extension.ts', module: join('instanceAdapter', 'mo2Instance') };

/** `relativePath` is relative to a source root, so a test directory above the root counts for nothing. */
export const isTestSupport = (relativePath: string): boolean =>
  relativePath.split(/[\\/]/).some((segment) => segment === 'test' || segment === 'integration') || relativePath.includes('.test.');

export const productionFiles = (root: string): string[] =>
  tsFiles(root).filter((path) => !isTestSupport(relative(root, path)));

export const rootFiles = (src: string = SRC): string[] =>
  productionFiles(src).filter((path) => basename(path) === relative(src, path));

const VI_MODULE_CALLS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);

const { SyntaxKind } = ts;

const ENDS_AN_OPERAND = new Set([
  SyntaxKind.Identifier, SyntaxKind.PrivateIdentifier, SyntaxKind.NumericLiteral, SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral, SyntaxKind.CloseParenToken, SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken, SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken, SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword, SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword,
]);

interface Token { kind: ts.SyntaxKind; text: string; endsAnOperand: boolean }

function indexBeforeTypeArguments(tokens: readonly Token[], end: number): number {
  if (tokens[end]?.kind !== SyntaxKind.GreaterThanToken) return end;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const kind = tokens[i]?.kind;
    if (kind === SyntaxKind.GreaterThanToken) depth++;
    else if (kind === SyntaxKind.LessThanToken && --depth === 0) return i - 1;
  }
  return -1;
}

function namesAModule(tokens: readonly Token[]): boolean {
  const last = tokens.length - 1;
  const lastKind = tokens[last]?.kind;
  if (lastKind === SyntaxKind.FromKeyword || lastKind === SyntaxKind.ImportKeyword) return true;
  if (lastKind !== SyntaxKind.OpenParenToken) return false;
  const callee = indexBeforeTypeArguments(tokens, last - 1);
  if (tokens[callee]?.kind === SyntaxKind.ImportKeyword) return true;
  const dot = tokens[callee - 1]?.kind;
  return tokens[callee]?.kind === SyntaxKind.Identifier && VI_MODULE_CALLS.has(tokens[callee].text)
    && (dot === SyntaxKind.DotToken || dot === SyntaxKind.QuestionDotToken)
    && tokens[callee - 2]?.kind === SyntaxKind.Identifier && tokens[callee - 2]?.text === 'vi'
    && tokens[callee - 3]?.kind !== SyntaxKind.DotToken;
}

export function importSpecifiers(sourceText: string, fileName: string): string[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, sourceText,
  );
  const found: string[] = [];
  const before: Token[] = [];
  const openBracesInTemplates: number[] = [];
  const bumpInnermostTemplate = (by: number): void => {
    openBracesInTemplates[openBracesInTemplates.length - 1] = (openBracesInTemplates[openBracesInTemplates.length - 1] ?? 0) + by;
  };
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const inTemplate = openBracesInTemplates.length > 0;
    if ((kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) && !before.at(-1)?.endsAnOperand) {
      kind = scanner.reScanSlashToken();
    } else if (kind === SyntaxKind.TemplateHead) {
      openBracesInTemplates.push(0);
    } else if (kind === SyntaxKind.OpenBraceToken && inTemplate) {
      bumpInnermostTemplate(1);
    } else if (kind === SyntaxKind.CloseBraceToken && inTemplate) {
      if ((openBracesInTemplates[openBracesInTemplates.length - 1] ?? 0) > 0) bumpInnermostTemplate(-1);
      else {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) openBracesInTemplates.pop();
      }
    }
    const text = scanner.getTokenValue();
    const isString = kind === SyntaxKind.StringLiteral;
    const isCallArgument = kind === SyntaxKind.NoSubstitutionTemplateLiteral && before.at(-1)?.kind === SyntaxKind.OpenParenToken;
    if ((isString || isCallArgument) && namesAModule(before)) found.push(text);
    before.push({ kind, text, endsAnOperand: ENDS_AN_OPERAND.has(kind) || scanner.isIdentifier() });
  }
  return found;
}

function isNotAPath(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  if (ts.isLiteralTypeNode(parent)) return true;
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  return ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword;
}

export function pathLiterals(sourceText: string, fileName: string): string[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && !isNotAPath(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export const pathSegments = (sourceText: string, fileName: string): Set<string> =>
  new Set(pathLiterals(sourceText, fileName).flatMap((literal) => literal.split(/[/\\]/)));
