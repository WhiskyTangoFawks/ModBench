import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { boxesIn } from './boxes';
import { importSpecifiers, isTestSupport, plantedTree, resolved, SRC, WEBVIEW_SRC } from './scanSource';
import { tsFiles } from './tsFiles';

type PastTheSeamByBox = Map<string, string[]>;

const modulesNamed = (file: string, specifiers: readonly string[]): string[] =>
  specifiers.flatMap((specifier) => resolved(file, specifier) ?? []);

const productionImports = (file: string): string[] =>
  modulesNamed(file, ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles.map((imported) => imported.fileName));

function pastTheSeam(src: string, webview: string): PastTheSeamByBox {
  const boxes = new Set(boxesIn(src).map((box) => box.name));
  const boxOf = (file: string): string | undefined => {
    const [top] = relative(src, file).split(sep);
    return top !== undefined && boxes.has(top) ? top : undefined;
  };
  const isProduction = (file: string, root: string): boolean => !isTestSupport(relative(root, file));
  const seam = new Set([src, webview].flatMap((root) => tsFiles(root, { exclude: ['generated'] })
    .filter((file) => isProduction(file, root))
    .flatMap((file) => productionImports(file).filter((target) => boxOf(target) !== undefined && boxOf(target) !== boxOf(file)))));
  const past: PastTheSeamByBox = new Map();
  for (const file of tsFiles(src).filter((path) => !isProduction(path, src))) {
    const box = boxOf(file);
    if (box === undefined) continue;
    const inside = modulesNamed(file, importSpecifiers(readFileSync(file, 'utf8'), file))
      .filter((target) => boxOf(target) === box && isProduction(target, src) && !seam.has(target));
    if (inside.length === 0) continue;
    const name = (path: string): string => relative(src, path).split(sep).join('/');
    past.set(box, [...(past.get(box) ?? []), `${name(file)}: ${[...new Set(inside.map(name))].sort().join(', ')}`].sort());
  }
  return new Map([...past].sort(([a], [b]) => a.localeCompare(b)));
}

const report = (past: PastTheSeamByBox): string => [...past]
  .map(([box, files]) => [`${box}: ${files.length}`, ...files.map((file) => `  ${file}`), ''].join('\n'))
  .join('');

describe('a test file of a box imports, of its own box, only its seam: the files another box imports', () => {
  it('reports each box\'s test files that import past its seam, and fails on none yet', () => {
    process.stdout.write(report(pastTheSeam(SRC, WEBVIEW_SRC)));
  });

  it('names a planted test file that imports past the seam, in every form a file names a module', () => {
    const root = plantedTree({
      'src/kernel/tsconfig.json': '{}',
      'src/kernel/codec.ts': 'export const c = 1;\n',
      'src/kernel/inner.ts': 'export const i = 1;\n',
      'src/kernel/shown.ts': 'export const s = 1;\n',
      'src/kernel/index.ts': "export { c } from './codec';\n",
      'src/view/tsconfig.json': '{ "references": [{ "path": "../kernel" }] }',
      'src/view/production.ts': "import { c } from '../kernel';\nexport const v = c;\n",
      'src/view/test/view.test.ts': "import { i } from '../../kernel/inner';\n",
      'src/wiring.ts': "import { c } from './kernel/codec';\nexport const w = c;\n",
      'webview/src/Panel.tsx': "import { s } from '../../src/kernel/shown';\nexport const P = () => <div>{s}</div>;\n",
      'src/test/shared.ts': "import { i } from '../kernel/inner';\nexport const d = i;\n",
      'src/kernel/test/fakeInner.ts': 'export const f = 1;\n',
      'src/kernel/test/harness.ts': "import { i } from '../inner';\nexport const h = i;\n",
      'src/kernel/test/atTheSeam.test.ts': [
        "import { c } from '..';",
        "import { c2 } from '../codec';",
        "import { s } from '../shown';",
        "import { f } from './fakeInner';",
        "import { d } from '../../test/shared';",
      ].join('\n'),
      'src/kernel/test/throughHarness.test.ts': "import { h } from './harness';\n",
      'src/kernel/test/inner.test.ts': [
        "import { i } from '../inner';",
        "import type { I } from '../inner';",
        "vi.mock('../inner', () => ({}));",
        "type T = typeof import('../inner');",
        "const later = import('../inner');",
      ].join('\n'),
      'src/kernel/inner.test.ts': "import { i } from './inner';\n",
    });
    const past = pastTheSeam(join(root, 'src'), join(root, 'webview', 'src'));
    expect(past).toEqual(new Map([['kernel', [
      'kernel/inner.test.ts: kernel/inner.ts',
      'kernel/test/harness.ts: kernel/inner.ts',
      'kernel/test/inner.test.ts: kernel/inner.ts',
    ]]]));
    expect(report(past)).toBe([
      'kernel: 3',
      '  kernel/inner.test.ts: kernel/inner.ts',
      '  kernel/test/harness.ts: kernel/inner.ts',
      '  kernel/test/inner.test.ts: kernel/inner.ts',
      '',
    ].join('\n'));
  });
});
