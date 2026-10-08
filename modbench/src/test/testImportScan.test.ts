import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { type Box, boxesIn } from './boxes';
import { importSpecifiers, SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const SHARED_TEST_SUPPORT = 'test';

const ROOT_BOX = '(composition root)';

function ownerOf(src: string, path: string, boxes: readonly Box[]): string | undefined {
  const rel = relative(src, path);
  if (rel.startsWith('..')) return undefined;
  const [top] = rel.split(sep);
  if (top === SHARED_TEST_SUPPORT) return SHARED_TEST_SUPPORT;
  return boxes.some((box) => box.name === top) ? top : ROOT_BOX;
}

function boxFiles(src: string, boxes: readonly Box[]): { file: string; box: Box }[] {
  const testedBoxes: Box[] = [...boxes, { name: ROOT_BOX, references: new Set(boxes.map((box) => box.name)) }];
  return tsFiles(src).flatMap((file) => {
    const box = testedBoxes.find((b) => b.name === ownerOf(src, file, boxes));
    return box ? [{ file, box }] : [];
  });
}

function unreferencedImports(src: string): string[] {
  const boxes = boxesIn(src);
  const offenders: string[] = [];
  for (const { file, box } of boxFiles(src, boxes)) {
    const own = box.name;
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'), file)) {
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
    'A file imports a box its own box\'s tsconfig does not reference. tsc also accepts a box reached '
    + 'only through another box\'s references, so the direct list is held here. A production file adds '
    + 'the reference only when layers.d2 draws it. A test drives its own box through the seams it owns: '
    + 'the boxes its tsconfig references, and the shared doubles in src/test. Answer another box\'s part '
    + 'with a fake at your box\'s seam, or move a test of two boxes composed to the composition root '
    + 'that composes them. Never add a reference to make a test compile.',
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

describe('a file reaches only its own box and the boxes that box references', () => {
  it('scans a real body of files across every box', () => {
    expect(boxFiles(SRC, boxesIn(SRC)).length).toBeGreaterThan(100);
    expect(boxesIn(SRC).map((box) => box.name)).toContain('loadOrderFileCodec');
  });

  it('every file imports only its own box, the boxes its tsconfig references and src/test', () => {
    assertEveryTestStaysInItsBox(unreferencedImports(SRC));
  });

  it('takes a test directory above src for no part of a file\'s path', () => {
    const parent = mkdtempSync(join(tmpdir(), 'medit-above-test-'));
    const src = join(parent, 'test', 'src');
    mkdirSync(join(src, 'view'), { recursive: true });
    mkdirSync(join(src, 'kernel'));
    writeFileSync(join(src, 'view', 'tsconfig.json'), '{ "references": [{ "path": "../kernel" }] }');
    writeFileSync(join(src, 'kernel', 'tsconfig.json'), '{}');
    writeFileSync(join(src, 'kernel', 'codec.ts'), 'export const x = 1;\n');
    writeFileSync(join(src, 'view', 'production.ts'), "import { x } from '../kernel/codec';\n");
    try {
      expect(unreferencedImports(src)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('names a planted import of an unreferenced box, in every form a file names a module', () => {
    const src = plantedTree({
      'kernel/tsconfig.json': '{ "include": ["**/*.ts"] }',
      'kernel/codec.ts': 'export const x = 1;\n',
      'view/tsconfig.json': '{\n  // a comment, as the real ones carry\n  "references": [{ "path": "../core" }]\n}',
      'core/tsconfig.json': '{ "references": [{ "path": "../kernel" }] }',
      'core/command.ts': 'export const y = 1;\n',
      'wiring.ts': 'export const z = 1;\n',
      'view/production.ts': "import { x } from '../kernel/codec';\nimport { y } from '../core/command';\nexport { x };\nexport { y };\n",
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
        'view/production.ts: ../kernel/codec (kernel)',
        'view/test/view.test.ts: ../../kernel/codec (kernel)',
        'view/test/view.test.ts: ../../kernel/codec (kernel)',
        'view/test/view.test.ts: ../../kernel/codec (kernel)',
        'view/test/view.test.ts: ../../kernel/codec (kernel)',
        `view/test/view.test.ts: ../../wiring (${ROOT_BOX})`,
      ]);
      expect(() => assertEveryTestStaysInItsBox(unreferencedImports(src))).toThrow(/never add a reference/i);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
