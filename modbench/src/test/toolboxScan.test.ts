// Two source-text invariants a compiling change can break silently: the retired vocabulary, and
// the Toolbox's own ownership of everything it constructs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';

const SRC = join(__dirname, '..');
const PACKAGE_JSON = join(SRC, '..', 'package.json');
// The root's wiring of the MO2 side, and the gestures the Toolbox box registers.
const TOOLBOX = join(SRC, 'toolbox.ts');
const TOOLBOX_COMMANDS = join(SRC, 'toolbox', 'toolboxCommands.ts');

// The view is the Toolbox, and the Instance is the only reader of MO2's files, so nothing is a
// "modlist source" any more. This file necessarily holds both words as data.
const RETIRED = [/loadout/i, /modlist\s*source/i];
const SELF = 'toolboxScan.test.ts';

function retiredWordsIn(text: string): string[] {
  return RETIRED.flatMap((pattern) => [...text.matchAll(new RegExp(pattern.source, 'gi'))].map((m) => m[0]));
}

describe('the retired names are gone from the extension source', () => {
  const scanned = [...tsFiles(SRC, { exclude: ['generated'] }), PACKAGE_JSON].filter((path) => !path.endsWith(SELF));

  it('scans a real body of files', () => {
    expect(scanned.length).toBeGreaterThan(100);
  });

  // File names, type names, view ids, command ids, setting keys and test names all live in this
  // text, so one scan covers every form.
  it.each(scanned.map((path) => relative(SRC, path)))('%s', (relativePath) => {
    const path = join(SRC, relativePath);
    expect({ [relativePath]: retiredWordsIn(readFileSync(path, 'utf8')) }).toEqual({ [relativePath]: [] });
  });

  it('no file is named for either', () => {
    expect(scanned.filter((path) => retiredWordsIn(path).length > 0)).toEqual([]);
  });

  // Rivals this catches: the word planted in a source file, and planted as a view id.
  it('flags the words wherever they are planted', () => {
    expect(retiredWordsIn('export class LoadoutHeaderProvider {}\n')).toEqual(['Loadout']);
    expect(retiredWordsIn("createTreeView('modbench.loadoutHeader', {})\n")).toEqual(['loadout']);
    expect(retiredWordsIn('"id": "modbench.loadoutHeader"')).toEqual(['loadout']);
    expect(retiredWordsIn('a modlist source is a thing')).toEqual(['modlist source']);
    expect(retiredWordsIn('new Mo2ModlistSource(root)')).toEqual(['ModlistSource']);
  });
});


// Every disposable the Toolbox constructs goes through `own`, so teardown is one list. A
// registration that skips it outlives the Toolbox and leaks across a reload.
const DISPOSABLE_PRODUCERS = [
  'Instance',
  'ModListProvider',
  'PluginsTreeProvider',
  'createTreeView',
  'createLoadOrderSender',
  'onDidChangeCheckboxState',
  'registerCreateEmptyModCommand',
  'registerCreatePluginCommand',
  'registerCommand',
  'registerToolboxCommands',
  'registerFileDecorationProvider',
  'registerModContextCommands',
  'registerModInstallCommands',
  'registerModListCoreCommands',
  'registerModSync',
  'registerNameFilter',
  'registerOpenFolderCommand',
  'registerOverwriteView',
  'registerPluginSync',
  'registerRefreshCommand',
  'registerSeparatorCommands',
  'registerViewOnNexusCommand',
  'ToolboxProvider',
  'subscribe',
];

// The trailing name of a call target: `vscode.window.createTreeView` reads as `createTreeView`,
// `new Instance` as `Instance`.
function calleeName(node: ts.CallExpression | ts.NewExpression): string | undefined {
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

// Owned where it is built, or handed straight back to a caller that owns it.
function transfersOwnership(node: ts.Node): boolean {
  if (ts.isReturnStatement(node) || ts.isArrowFunction(node)) return true;
  // An element of an array is owned by whoever owns the array, so the question moves up to it.
  if (ts.isArrayLiteralExpression(node)) return transfersOwnership(node.parent);
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node);
  return name === 'own' || name === 'ownAll';
}

// Producer calls that no own()/ownAll() call encloses, as `name:line`.
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

describe('the Toolbox owns every disposable it constructs', () => {
  it.each([TOOLBOX, TOOLBOX_COMMANDS].map((path) => relative(SRC, path)))(
    'every registration in %s is owned, or returned to a caller that owns it',
    (relativePath) => {
      expect(unownedProducers(parse(join(SRC, relativePath)))).toEqual([]);
    });

  it('finds the registrations at all — an empty scan would pass vacuously', () => {
    expect([...readFileSync(TOOLBOX, 'utf8').matchAll(/\bown(?:All)?\(/g)].length).toBeGreaterThan(15);
    expect([...readFileSync(TOOLBOX_COMMANDS, 'utf8').matchAll(/\bregisterCommand\(/g)].length).toBeGreaterThan(0);
  });

  // Rival this catches: one disposable dropped from the Toolbox's teardown list.
  it('names the producer a dropped own() left unowned', () => {
    const planted = "vscode.window.createTreeView('modbench.toolbox', {});\n";
    expect(unownedProducers(parse('planted.ts', `const view = ${planted}`))).toEqual(['createTreeView:1']);
    expect(unownedProducers(parse('planted.ts', `own(${planted})`))).toEqual([]);
    expect(unownedProducers(parse('planted.ts', `function f() { return ${planted} }`))).toEqual([]);
    // A registration returned inside an array is owned by whoever owns the array; the same
    // registration left in an array nobody hands on is not.
    expect(unownedProducers(parse('planted.ts', `function f() { return [${planted}] }`))).toEqual([]);
    expect(unownedProducers(parse('planted.ts', `const all = [${planted}]`))).toEqual(['createTreeView:1']);
  });
});
