import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { SOURCE_ROOTS, SRC, WEBVIEW_SRC, importSpecifiers, isTestSupport, productionFiles, rootFiles } from './scanSource';
import { boxesIn, referencesOf } from './boxes';
import { tsFiles } from './tsFiles';

let root: string | undefined;

function plantedTree(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'medit-scan-source-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('the source roots', () => {
  it('are the extension source and the webview source', () => {
    expect(SOURCE_ROOTS).toEqual([SRC, WEBVIEW_SRC]);
    expect(WEBVIEW_SRC).toBe(join(SRC, '..', 'webview', 'src'));
  });
});

describe('isTestSupport', () => {
  it.each([
    ['modlist/x.test.ts'],
    ['modlist/View.test.tsx'],
    ['test/double.ts'],
    ['modlist/test/double.ts'],
    ['test/integration/run.ts'],
    ['a\\test\\b.ts'],
    ['integration/run.ts'],
  ])('holds %s', (path) => {
    expect(isTestSupport(path)).toBe(true);
  });

  it.each([['modlist/x.ts'], ['extension.ts'], ['latest/x.ts'], ['modlist/attestation.ts']])('does not hold %s', (path) => {
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

  it('lists the webview components', () => {
    expect(productionFiles(WEBVIEW_SRC).some((path) => path.endsWith('.tsx'))).toBe(true);
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

  it('finds the composition root in the real tree', () => {
    expect(rootFiles()).toContain(join(SRC, 'extension.ts'));
  });
});

describe('importSpecifiers', () => {
  const specifiers = (text: string): string[] => importSpecifiers(text, 'file.ts');

  it('reads import and export declarations, type-only and side-effect included', () => {
    expect(specifiers([
      "import a from './a';",
      "import type { B } from './b';",
      "import './c';",
      "export { d } from './d';",
      "export * from './e';",
      "export type { F } from './f';",
    ].join('\n'))).toEqual(['./a', './b', './c', './d', './e', './f']);
  });

  it('reads a multi-line import', () => {
    expect(specifiers("import {\n  a,\n  b,\n} from './multi';")).toEqual(['./multi']);
  });

  it('reads a dynamic import and an import type', () => {
    expect(specifiers("const m = await import('./dyn');\ntype T = import('./ty').T;")).toEqual(['./dyn', './ty']);
  });

  it('reads vi module calls', () => {
    expect(specifiers([
      "vi.mock('./m');",
      "vi.doMock('./dm');",
      "vi.unmock('./um');",
      "await vi.importActual('./ia');",
      "await vi.importMock('./im');",
    ].join('\n'))).toEqual(['./m', './dm', './um', './ia', './im']);
  });

  it('reads no specifier from a string or comment that looks like an import', () => {
    expect(specifiers("// import x from './nope';\nconst s = \"import y from './nope2'\";\nfoo.mock('./nope3');")).toEqual([]);
  });

  it('reads a tsx file', () => {
    expect(importSpecifiers("import { A } from './a';\nexport const x = <A />;", 'view.tsx')).toEqual(['./a']);
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

  it('defaults to the real source tree', () => {
    expect(boxesIn().map((box) => box.name)).toContain('loadOrderFileCodec');
    expect(referencesOf('modlist')).toEqual(['coreLib', 'instanceAdapter', 'ports']);
  });
});

describe('the scans declare no walker, filter or specifier reader of their own', () => {
  const OWN_DECLARATIONS = ['isTestSupport', 'importSpecifiers'];
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

  it('flags each name however it is declared', () => {
    expect(declaredShared("import { readdirSync } from 'node:fs';")).toEqual(['readdirSync']);
    expect(declaredShared("import { readdirSync as list } from 'node:fs';")).toEqual(['readdirSync']);
    expect(declaredShared("import * as fs from 'node:fs';\nconst names = fs.readdirSync('.');")).toEqual(['readdirSync']);
    expect(declaredShared('const isTestSupport = (p: string) => p.includes("test");')).toEqual(['isTestSupport']);
    expect(declaredShared('function importSpecifiers(text: string) { return [text]; }')).toEqual(['importSpecifiers']);
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
