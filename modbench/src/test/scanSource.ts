import { basename, join, relative } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';

export const SRC = join(__dirname, '..');
export const WEBVIEW_SRC = join(SRC, '..', 'webview', 'src');
export const SOURCE_ROOTS = [SRC, WEBVIEW_SRC];

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
