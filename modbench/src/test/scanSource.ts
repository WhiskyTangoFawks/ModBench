import { basename, join, relative } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';

export const SRC = join(__dirname, '..');
export const WEBVIEW_SRC = join(SRC, '..', 'webview', 'src');
export const SOURCE_ROOTS = [SRC, WEBVIEW_SRC];

export const MO2_NAMES = {
  anywhere: [/mo2/i, /modorganizer/i, /\bMod Organizer\b/i],
  files: ['modlist.txt', 'ModOrganizer.ini', 'meta.ini', '.mohidden'],
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

function isModuleCall(call: ts.CallExpression): boolean {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && callee.expression.text === 'vi' && VI_MODULE_CALLS.has(callee.name.text);
}

export function importSpecifiers(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && isModuleCall(node)) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
