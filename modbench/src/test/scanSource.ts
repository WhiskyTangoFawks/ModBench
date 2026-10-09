import { basename, join, relative } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';

export const SRC = join(__dirname, '..');
export const WEBVIEW_SRC = join(SRC, '..', 'webview', 'src');
export const SOURCE_ROOTS = [SRC, WEBVIEW_SRC];

export const MO2_NAMES = {
  anywhere: [/mo2/i, /modorganizer/i, /\bMod Organizer\b/i],
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
  SyntaxKind.PrivateIdentifier, SyntaxKind.NumericLiteral, SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral, SyntaxKind.CloseParenToken, SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken, SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken, SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword, SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword,
]);

const BEGINS_AN_OPERAND = new Set([SyntaxKind.AwaitKeyword, SyntaxKind.YieldKeyword, SyntaxKind.OfKeyword]);

interface Token { kind: ts.SyntaxKind; text: string; endsAnOperand: boolean }

const isMemberAccess = (kind: ts.SyntaxKind | undefined): boolean =>
  kind === SyntaxKind.DotToken || kind === SyntaxKind.QuestionDotToken;

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

function isBareImport(tokens: readonly Token[], index: number): boolean {
  return tokens[index]?.kind === SyntaxKind.ImportKeyword && !isMemberAccess(tokens[index - 1]?.kind);
}

function fromClosesADeclaration(tokens: readonly Token[], from: number): boolean {
  for (let i = from - 1; i >= 0; i--) {
    const kind = tokens[i]?.kind;
    if (kind === SyntaxKind.ImportKeyword || kind === SyntaxKind.ExportKeyword) return true;
    if (kind === SyntaxKind.SemicolonToken) return false;
  }
  return false;
}

function namesAModule(tokens: readonly Token[]): boolean {
  const last = tokens.length - 1;
  const lastKind = tokens[last]?.kind;
  if (lastKind === SyntaxKind.FromKeyword) return fromClosesADeclaration(tokens, last);
  if (isBareImport(tokens, last)) return true;
  if (lastKind !== SyntaxKind.OpenParenToken) return false;
  const callee = indexBeforeTypeArguments(tokens, last - 1);
  if (isBareImport(tokens, callee)) return true;
  return tokens[callee]?.kind === SyntaxKind.Identifier && VI_MODULE_CALLS.has(tokens[callee].text)
    && isMemberAccess(tokens[callee - 1]?.kind)
    && tokens[callee - 2]?.kind === SyntaxKind.Identifier && tokens[callee - 2]?.text === 'vi'
    && !isMemberAccess(tokens[callee - 3]?.kind);
}

/** Reads TypeScript, not JSX. Throws on a token it cannot read, so a misread file never drops its imports in silence. */
export function importSpecifiers(sourceText: string, fileName: string): string[] {
  if (fileName.endsWith('.tsx')) throw new Error(`${fileName}: the import reader does not read JSX`);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, sourceText,
    (message) => {
      const line = sourceText.slice(0, scanner.getTokenEnd()).split('\n').length;
      throw new Error(`${fileName}:${line}: the import reader cannot read this file: ${ts.flattenDiagnosticMessageText(message.message, ' ')}`);
    },
  );
  const found: string[] = [];
  const before: Token[] = [];
  const braceOpensTemplateSpan: boolean[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const previous = before.at(-1);
    if ((kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) && !previous?.endsAnOperand) {
      kind = scanner.reScanSlashToken();
    } else if (kind === SyntaxKind.TemplateHead) {
      braceOpensTemplateSpan.push(true);
    } else if (kind === SyntaxKind.OpenBraceToken) {
      braceOpensTemplateSpan.push(false);
    } else if (kind === SyntaxKind.CloseBraceToken && braceOpensTemplateSpan.pop()) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === SyntaxKind.TemplateMiddle) braceOpensTemplateSpan.push(true);
    }
    const text = scanner.getTokenValue();
    const isString = kind === SyntaxKind.StringLiteral;
    const isCallArgument = kind === SyntaxKind.NoSubstitutionTemplateLiteral && previous?.kind === SyntaxKind.OpenParenToken;
    if ((isString || isCallArgument) && namesAModule(before)) found.push(text);
    const endsAnOperand = ENDS_AN_OPERAND.has(kind) || (scanner.isIdentifier() && !BEGINS_AN_OPERAND.has(kind));
    before.push({ kind, text, endsAnOperand });
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
