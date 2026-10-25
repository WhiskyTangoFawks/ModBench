import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { SRC } from './scanSource';

const ACTIVATION = join(SRC, 'extension.ts');
const TOOLBOX_COMMANDS = join(SRC, 'toolbox', 'toolboxCommands.ts');

const DISPOSABLE_PRODUCERS = [
  'Instance',
  'createModsView',
  'createDownloadsView',
  'createPluginsView',
  'createTreeView',
  'onDidChangeCheckboxState',
  'registerCommand',
  'registerToolboxCommands',
  'registerFileDecorationProvider',
  'registerRefreshCommand',
  'ToolboxProvider',
  'subscribe',
];

function calleeName(node: ts.CallExpression | ts.NewExpression): string | undefined {
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

function transfersOwnership(node: ts.Node): boolean {
  if (ts.isReturnStatement(node) || ts.isArrowFunction(node)) return true;
  if (ts.isArrayLiteralExpression(node)) return transfersOwnership(node.parent);
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node);
  return name === 'own' || name === 'ownAll';
}

function unownedProducers(source: ts.SourceFile): string[] {
  const unowned: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && DISPOSABLE_PRODUCERS.includes(name) && !transfersOwnership(node.parent)) {
        unowned.push(`${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return unowned;
}

const parse = (path: string, text = readFileSync(path, 'utf8')): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

describe('the activation file and Toolbox commands own every disposable they construct', () => {
  it.each([ACTIVATION, TOOLBOX_COMMANDS].map((path) => relative(SRC, path)))(
    'every registration in %s is owned, or returned to a caller that owns it',
    (relativePath) => {
      expect(unownedProducers(parse(join(SRC, relativePath)))).toEqual([]);
    });

  it('finds the registrations at all — an empty scan would pass vacuously', () => {
    expect([...readFileSync(ACTIVATION, 'utf8').matchAll(/\bown(?:All)?\(/g)].length).toBeGreaterThan(15);
    expect([...readFileSync(TOOLBOX_COMMANDS, 'utf8').matchAll(/\bregisterCommand\(/g)].length).toBeGreaterThan(0);
  });

  const PRODUCER = "vscode.window.createTreeView('modbench.toolbox', {});\n";

  it.each([
    ['names a producer kept in a constant', `const view = ${PRODUCER}`, ['createTreeView:1']],
    ['names a producer kept in an array', `const all = [${PRODUCER}]`, ['createTreeView:1']],
    ['passes a producer handed to own()', `own(${PRODUCER})`, []],
    ['passes a producer returned to the caller', `function f() { return ${PRODUCER} }`, []],
    ['passes a producer returned in an array', `function f() { return [${PRODUCER}] }`, []],
  ])('%s', (_, text, unowned) => {
    expect(unownedProducers(parse('planted.ts', text))).toEqual(unowned);
  });
});
