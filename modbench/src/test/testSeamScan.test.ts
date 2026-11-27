import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { boxesIn } from './boxes';
import { importSpecifiers, isTestSupport, plantedTree, productionFiles, resolved, SRC, WEBVIEW_SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const NEEDS_AN_INTERNAL: Readonly<Record<string, { readonly why: string; readonly imports: readonly string[] }>> = {
  'test/agentGestures.test.ts': {
    why: 'reads the agent\'s table of gestures against the gestures the spec catalogs',
    imports: ['agent/gestures.ts'],
  },
  'test/fakeInstanceAdapter.ts': {
    why: 'the Instance adapter\'s second adapter: it answers by the adapter\'s own rules, never a copy of them (ADR-0014)',
    imports: [
      'instanceAdapter/excludedPaths.ts', 'instanceAdapter/fileContents/contentDigest.ts', 'instanceAdapter/gameFolder/pathWithin.ts', 'instanceAdapter/modGroups.ts',
      'instanceAdapter/modValue.ts', 'instanceAdapter/nexusPage.ts', 'instanceAdapter/pluginsProvided.ts',
    ],
  },
  'test/fomodEngines/repeatsStep.ts': {
    why: 'a FOMOD engine process speaks the protocol the Instance adapter speaks to its own process',
    imports: ['instanceAdapter/fomodInstaller/engineProtocol.ts'],
  },
  'test/mo2/fakeInstance.ts': {
    why: 'a fake Instance tells a subscriber what changed as the Instance does',
    imports: ['instanceLoader/told.ts'],
  },
  'test/packageJson.test.ts': {
    why: 'reads the manifest against what the views hold: the setting keys they read, their rows\' contexts and their empty-list messages',
    imports: ['mods/ModListProvider.ts', 'mods/conflictTableEditor.ts', 'mods/inactiveFiles.ts', 'mods/modIndicators.ts', 'mods/openRows.ts', 'plugins/PluginsTreeProvider.ts'],
  },
  'test/scaleGate.ts': {
    why: 'the scale gate counts the work at each layer: the Mods view\'s tree, decorations and conflict table, and each change Symbols hears; it writes its modlist through MO2\'s codec, as no test spells a format',
    imports: [
      'instanceAdapter/mo2/codecs/modlistText.ts', 'mods/ModListProvider.ts', 'mods/conflictTableEditor.ts', 'mods/modDecorations.ts', 'mods/openRows.ts',
      'symbols/heardChanges.ts', 'symbols/scriptLanguage.ts',
    ],
  },
};

const modulesNamed = (file: string, specifiers: readonly string[]): string[] =>
  specifiers.flatMap((specifier) => resolved(file, specifier) ?? []);

const productionImports = (file: string): string[] =>
  modulesNamed(file, ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles.map((imported) => imported.fileName));

function pastTheSeam(src: string, webview: string): Map<string, string[]> {
  const boxes = new Set(boxesIn(src).map((box) => box.name));
  const boxOf = (file: string): string | undefined => {
    const [top] = relative(src, file).split(sep);
    return top !== undefined && boxes.has(top) ? top : undefined;
  };
  const isTestSide = (file: string): boolean => isTestSupport(relative(src, file));
  const name = (path: string): string => relative(src, path).split(sep).join('/');
  const seam = new Set([src, webview].flatMap(productionFiles)
    .flatMap((file) => productionImports(file).filter((target) => boxOf(target) !== boxOf(file))));
  return new Map(tsFiles(src).filter(isTestSide).sort().flatMap((file) => {
    const inside = modulesNamed(file, importSpecifiers(readFileSync(file, 'utf8'), file))
      .filter((target) => boxOf(target) !== undefined && !isTestSide(target) && !seam.has(target));
    return inside.length === 0 ? [] : [[name(file), [...new Set(inside.map(name))].sort()] as const];
  }));
}

describe('a test file imports, of a box, only its seam: the files another box imports', () => {
  const past = pastTheSeam(SRC, WEBVIEW_SRC);

  it('names each test file that imports past a box\'s seam, and each file it imports there that the allowed list does not', () => {
    expect([...past].flatMap(([file, inside]) => inside.filter((one) => NEEDS_AN_INTERNAL[file]?.imports.includes(one) !== true).map((one) => `${file}: ${one}`)))
      .toEqual([]);
  });

  it('allows no import a file no longer makes', () => {
    expect(Object.entries(NEEDS_AN_INTERNAL).flatMap(([file, { imports }]) => imports.filter((one) => past.get(file)?.includes(one) !== true).map((one) => `${file}: ${one}`)))
      .toEqual([]);
  });

  it('names a planted test-side file that imports a box\'s file no other box\'s production code imports', () => {
    const root = plantedTree({
      'src/kernel/tsconfig.json': '{}',
      'src/kernel/codec.ts': "import { i } from './inner';\nexport const c = i;\n",
      'src/kernel/inner.ts': 'export const i = 1;\n',
      'src/kernel/shown.ts': 'export const s = 1;\n',
      'src/kernel/index.ts': "export { c } from './codec';\n",
      'src/view/tsconfig.json': '{ "references": [{ "path": "../kernel" }] }',
      'src/view/production.ts': "import { c } from '../kernel';\nexport const v = c;\n",
      'src/view/test/view.test.ts': "import { i } from '../../kernel/inner';\n",
      'src/wiring.ts': "import { c } from './kernel/codec';\nexport const w = c;\n",
      'webview/src/Panel.tsx': "import { s } from '../../src/kernel/shown';\nexport const P = () => <div>{s}</div>;\n",
      'src/test/shared.ts': "import { i } from '../kernel/inner';\nimport { w } from '../wiring';\nimport { c } from '../kernel';\nexport const d = i + w + c;\n",
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
      'src/kernel/test/inner.test.ts': "vi.mock('../inner', () => ({}));\n",
      'src/kernel/inner.test.ts': "import { i } from './inner';\n",
    });
    expect(pastTheSeam(join(root, 'src'), join(root, 'webview', 'src'))).toEqual(new Map([
      ['kernel/inner.test.ts', ['kernel/inner.ts']],
      ['kernel/test/harness.ts', ['kernel/inner.ts']],
      ['kernel/test/inner.test.ts', ['kernel/inner.ts']],
      ['test/shared.ts', ['kernel/inner.ts']],
      ['view/test/view.test.ts', ['kernel/inner.ts']],
    ]));
  });
});
