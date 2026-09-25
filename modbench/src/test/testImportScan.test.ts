// A box's tests compile in the one test project, which references every box, so `tsc -b` never
// refuses a test that reaches past its own box's reference list. This scan does.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';

const SRC = join(__dirname, '..');

// Shared doubles and fixtures every box's tests may use: compiled only in the test project.
const SHARED_TEST_SUPPORT = 'test';

// The composition root's own files sit in src/ itself, outside every box directory.
const ROOT_BOX = '(composition root)';

const VI_MODULE_CALLS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);

interface Box {
  name: string;
  references: Set<string>;
}

// A box is a directory of src/ holding its own tsconfig.json; its references are that file's.
function boxesIn(src: string): Box[] {
  return readdirSync(src, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(src, entry.name, 'tsconfig.json')))
    .map((entry) => {
      const path = join(src, entry.name, 'tsconfig.json');
      const read: { config?: unknown; error?: ts.Diagnostic } = ts.readConfigFile(path, (p) => readFileSync(p, 'utf8'));
      if (read.error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
      return { name: entry.name, references: new Set(referencePaths(read.config).map((r) => basename(r))) };
    });
}

function referencePaths(config: unknown): string[] {
  if (typeof config !== 'object' || config === null || !('references' in config)) return [];
  const { references } = config;
  if (!Array.isArray(references)) return [];
  return references.flatMap((reference: unknown) =>
    (typeof reference === 'object' && reference !== null && 'path' in reference && typeof reference.path === 'string'
      ? [reference.path] : []));
}

// Every module a test names: imports and re-exports, `import()` in code and in types, and the
// module paths vitest's own mock and import helpers take.
function moduleSpecifiers(sourceText: string, fileName: string): string[] {
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

function isModuleCall(call: ts.CallExpression): boolean {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && callee.expression.text === 'vi' && VI_MODULE_CALLS.has(callee.name.text);
}

// The box a path inside src/ belongs to: its top directory when that is a box, the shared test
// support, or the composition root for everything else under src/.
function ownerOf(src: string, path: string, boxes: readonly Box[]): string | undefined {
  const rel = relative(src, path);
  if (rel.startsWith('..')) return undefined;
  const [top] = rel.split(sep);
  if (top === SHARED_TEST_SUPPORT) return SHARED_TEST_SUPPORT;
  return boxes.some((box) => box.name === top) ? top : ROOT_BOX;
}

const isTestFile = (path: string): boolean =>
  path.endsWith('.test.ts') || path.split(sep).includes('test');

// Each box's own tests, with the box that owns them; the shared support is no box's.
function boxTests(src: string, boxes: readonly Box[]): { file: string; box: Box }[] {
  const testedBoxes: Box[] = [...boxes, { name: ROOT_BOX, references: new Set(boxes.map((box) => box.name)) }];
  return tsFiles(src).filter(isTestFile).flatMap((file) => {
    const box = testedBoxes.find((b) => b.name === ownerOf(src, file, boxes));
    return box ? [{ file, box }] : [];
  });
}

// `file: specifier (box)` for each module a test names in a box its own box does not reference.
function unreferencedImports(src: string): string[] {
  const boxes = boxesIn(src);
  const offenders: string[] = [];
  for (const { file, box } of boxTests(src, boxes)) {
    const own = box.name;
    for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'), file)) {
      if (!specifier.startsWith('.')) continue;
      const target = ownerOf(src, resolve(dirname(file), specifier), boxes) ?? 'outside src/';
      if (target === own || target === SHARED_TEST_SUPPORT || box.references.has(target)) continue;
      offenders.push(`${relative(src, file).split(sep).join('/')}: ${specifier} (${target})`);
    }
  }
  return offenders.sort();
}

function assertEveryTestStaysInItsBox(offenders: readonly string[]): void {
  expect(
    offenders,
    'A test imports a box its own box\'s tsconfig does not reference. A test drives its own box '
    + 'through the seams it owns: the boxes its tsconfig references, and the shared doubles in '
    + 'src/test. Answer another box\'s part with a fake at your box\'s seam, or move a test of two '
    + 'boxes composed to the composition root that composes them. The reference lists are the '
    + 'maintainer\'s: never add one to make a test compile.',
  ).toEqual([]);
}

function plantedTree(files: Record<string, string>): string {
  const src = mkdtempSync(join(tmpdir(), 'medit-test-import-scan-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  return src;
}

describe('a test reaches only its own box and the boxes that box references', () => {
  it('scans a real body of test files across every box', () => {
    expect(boxTests(SRC, boxesIn(SRC)).length).toBeGreaterThan(100);
    expect(boxesIn(SRC).map((box) => box.name)).toContain('mo2Codecs');
  });

  it('every test file imports only its own box, the boxes its tsconfig references and src/test', () => {
    assertEveryTestStaysInItsBox(unreferencedImports(SRC));
  });

  it('names a planted import of an unreferenced box, in every form a test names a module', () => {
    const src = plantedTree({
      'kernel/tsconfig.json': '{ "include": ["**/*.ts"] }',
      'kernel/codec.ts': 'export const x = 1;\n',
      'view/tsconfig.json': '{\n  // a comment, as the real ones carry\n  "references": [{ "path": "../core" }]\n}',
      'core/tsconfig.json': '{ "references": [{ "path": "../kernel" }] }',
      'core/command.ts': 'export const y = 1;\n',
      'wiring.ts': 'export const z = 1;\n',
      'test/double.ts': 'export const d = 1;\n',
      'view/test/view.test.ts': [
        "import { y } from '../../core/command';",
        "import { d } from '../../test/double';",
        "import { x } from '../../kernel/codec';",
        "import type { z } from '../../wiring';",
        "vi.mock('../../kernel/codec', () => ({}));",
        "type Codec = typeof import('../../kernel/codec');",
        "const later = import('../../kernel/codec');",
        "const outside = '../../kernel/codec';",
      ].join('\n'),
    });
    try {
      expect(unreferencedImports(src)).toEqual([
        'view/test/view.test.ts: ../../kernel/codec (kernel)',
        'view/test/view.test.ts: ../../kernel/codec (kernel)',
        'view/test/view.test.ts: ../../kernel/codec (kernel)',
        'view/test/view.test.ts: ../../kernel/codec (kernel)',
        `view/test/view.test.ts: ../../wiring (${ROOT_BOX})`,
      ]);
      expect(() => assertEveryTestStaysInItsBox(unreferencedImports(src))).toThrow(/never add one/);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
