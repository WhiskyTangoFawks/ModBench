import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { SRC, importSpecifiers, isTestSupport, plantedTree, productionFiles, rootFiles } from './scanSource';
import { boxesIn, referencesOf } from './boxes';
import { tsFiles } from './tsFiles';

describe('isTestSupport', () => {
  it.each([
    ['modCommands/x.test.ts'],
    ['modCommands/View.test.tsx'],
    ['test/double.ts'],
    ['modCommands/test/double.ts'],
    ['test/integration/run.ts'],
    ['a\\test\\b.ts'],
    ['integration/run.ts'],
  ])('holds %s', (path) => {
    expect(isTestSupport(path)).toBe(true);
  });

  it.each([['modCommands/x.ts'], ['extension.ts'], ['latest/x.ts'], ['modCommands/attestation.ts']])('does not hold %s', (path) => {
    expect(isTestSupport(path)).toBe(false);
  });
});

describe('productionFiles', () => {
  it('lists .ts and .tsx files and drops every file isTestSupport holds', () => {
    const dir = plantedTree({
      'a.ts': '', 'b.tsx': '', 'sub/d.ts': '',
      'a.test.ts': '', 'b.test.tsx': '', 'sub/foo.test.ts': '',
      'test/c.ts': '', 'sub/test/e.ts': '', 'integration/f.ts': '', 'sub/integration/g.ts': '',
    });
    expect(productionFiles(dir).sort()).toEqual([join(dir, 'a.ts'), join(dir, 'b.tsx'), join(dir, 'sub', 'd.ts')].sort());
  });

  it('is not fooled by a test directory above the root', () => {
    const dir = plantedTree({ 'test/src/a.ts': '' });
    expect(productionFiles(join(dir, 'test', 'src'))).toEqual([join(dir, 'test', 'src', 'a.ts')]);
  });
});

describe('rootFiles', () => {
  it('lists the production files directly under the root', () => {
    const dir = plantedTree({ 'extension.ts': '', 'extension.test.ts': '', 'box/inner.ts': '' });
    expect(rootFiles(dir)).toEqual([join(dir, 'extension.ts')]);
  });
});

describe('importSpecifiers', () => {
  it.each([
    ['import and export declarations, type-only and side-effect included', [
      "import a from './a';",
      "import type { B } from './b';",
      "import './c';",
      "export { d } from './d';",
      "export * from './e';",
      "export type { F } from './f';",
    ].join('\n'), ['./a', './b', './c', './d', './e', './f']],
    ['a multi-line import', "import {\n  a,\n  b,\n} from './multi';", ['./multi']],
    ['a dynamic import and an import type', "const m = await import('./dyn');\ntype T = import('./ty').T;", ['./dyn', './ty']],
    ['vi module calls', [
      "vi.mock('./m');",
      "vi.doMock('./dm');",
      "vi.unmock('./um');",
      "await vi.importActual('./ia');",
      "await vi.importMock('./im');",
    ].join('\n'), ['./m', './dm', './um', './ia', './im']],
    ['no specifier from a string or comment that looks like an import',
      "// import x from './nope';\nconst s = \"import y from './nope2'\";\nfoo.mock('./nope3');", []],
    ['a vi module call that carries type arguments, and not one on another object', [
      "await vi.importActual<typeof import('./ty')>('./ia');",
      "await vi.importActual<Map<string, Set<number>>>('./nested');",
      "foo.vi.mock('./nope');",
      "vi.fn('./nope2');",
    ].join('\n'), ['./ty', './ia', './nested']],
    ['past a regular expression, a template and a division that hold a quote', [
      "const re = /'/g; import before from './before'; const half = a / b / c;",
      "const t = `it's ${ `nested ' ${ x / 2 }` } ${ { a: 1 }.a } end`;",
      "import after from './after';",
    ].join('\n'), ['./before', './after']],
    ['past a regular expression after await', "await /`/.exec(s);\nimport after from './after';", ['./after']],
    ['past a regular expression after yield', "yield /`/.exec(s);\nimport after from './after';", ['./after']],
    ['past a regular expression after of', "for (const m of /`/g) {}\nimport after from './after';", ['./after']],
    ['past a regular expression that opens like a division-assignment', "const r = /=a'/;\nimport after from './after';", ['./after']],
    ['doUnmock, an optional-chained vi call and a template-literal argument',
      "vi.doUnmock('./du'); vi?.mock('./oc'); vi.mock(`./tl`);", ['./du', './oc', './tl']],
    ['no module from a method named import, a vi behind a member access, or prose saying from', [
      "import a from './a';",
      "y.import('./no1'); x?.vi.mock('./no2'); x.vi.mock('./no3');",
      "const s = <br>Copy from 'disk';",
    ].join('\n'), ['./a']],
  ])('reads %s', (_, text, expected) => {
    expect(importSpecifiers(text, 'file.ts')).toEqual(expected);
  });

  it.each([
    ['a tsx file, whose JSX text it cannot tokenise', "import { A } from './a';", 'view.tsx', /does not read JSX/],
    ['text it misreads, naming the file and line',
      "import before from './before';\nif (x) {}\n/`/.test(s);\nimport after from './after';", 'file.ts', /file\.ts:\d+:/],
    ['text it misreads, saying it cannot read it',
      "import before from './before';\nif (x) /`/.test(s);\nimport after from './after';", 'file.ts', /cannot read/],
  ])('throws, rather than drop the imports below, on %s', (_, text, fileName, error) => {
    expect(() => importSpecifiers(text, fileName)).toThrow(error);
  });
});

describe('boxesIn and referencesOf, parameterised by root', () => {
  it('reads a planted tree: a box is a folder with a tsconfig, its references are the tsconfig\'s', () => {
    const src = plantedTree({
      'kernel/tsconfig.json': '{}',
      'view/tsconfig.json': '{\n // comment\n "references": [{ "path": "../kernel" }, { "path": "../core" }]\n}',
      'core/tsconfig.json': '{}',
      'loose/file.ts': '',
    });
    expect(boxesIn(src).map((box) => box.name).sort()).toEqual(['core', 'kernel', 'view']);
    expect(referencesOf('view', src)).toEqual(['core', 'kernel']);
    expect(referencesOf('kernel', src)).toEqual([]);
  });
});

describe('the scans declare no walker, filter, specifier reader or planted tree of their own', () => {
  const OWN_DECLARATIONS = ['isTestSupport', 'importSpecifiers', 'plantedTree'];
  const HELPERS = ['scanSource.ts', 'tsFiles.ts', 'boxes.ts'];

  function declaredShared(sourceText: string): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name)
        && OWN_DECLARATIONS.includes(node.name.text)) found.push(node.name.text);
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'readdirSync') found.push('readdirSync');
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'readdirSync') found.push('readdirSync');
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('scan.ts', sourceText, ts.ScriptTarget.Latest, true));
    return found;
  }

  it.each([
    ['an imported walker', "import { readdirSync } from 'node:fs';", 'readdirSync'],
    ['a walker imported under another name', "import { readdirSync as list } from 'node:fs';", 'readdirSync'],
    ['a walker called through its module', "import * as fs from 'node:fs';\nconst names = fs.readdirSync('.');", 'readdirSync'],
    ['a filter declared as a constant', 'const isTestSupport = (p: string) => p.includes("test");', 'isTestSupport'],
    ['a specifier reader declared as a function', 'function importSpecifiers(text: string) { return [text]; }', 'importSpecifiers'],
    ['a planted tree of its own', 'async function plantedTree(files: Record<string, string>) { return files; }', 'plantedTree'],
  ])('flags %s', (_, text, name) => {
    expect(declaredShared(text)).toEqual([name]);
  });

  it('holds for every file under src/test and src/*/test but the helpers and the integration suite, which lists a trash folder, not source', () => {
    const scans = tsFiles(SRC).filter((path) => {
      const segments = relative(SRC, path).split(sep);
      return segments.includes('test') && !segments.includes('integration') && !HELPERS.includes(basename(path));
    });
    expect(scans.length).toBeGreaterThan(100);
    const offenders = Object.fromEntries(scans
      .map((path) => [relative(SRC, path), declaredShared(readFileSync(path, 'utf8'))] as const)
      .filter(([, names]) => names.length > 0));
    expect(offenders).toEqual({});
  });
});
