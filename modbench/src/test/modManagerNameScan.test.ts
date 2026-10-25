import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { CONSTRUCTION, IMPLEMENTATIONS, isTestSupport, MANIFEST, plantedTree, sourceFiles, SOURCE_ROOTS, SRC, WALKTHROUGH, WEBVIEW_SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const ADAPTER = 'instanceAdapter';
const ADAPTER_INTERFACE = join(ADAPTER, 'instanceAdapter.ts');

type Implementation = (typeof IMPLEMENTATIONS)[number];

const entryOf = ({ module }: Implementation): string => `./${module.split(sep).join('/')}`;

const isImplementation = ({ folder }: Implementation, relPath: string): boolean => relPath.startsWith(join(ADAPTER, folder) + sep);

function constructionImport(sourceText: string, fileName: string, implementation: Implementation): { text: string; bindings: string[] } | undefined {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === entryOf(implementation));
  const bindings = declaration?.importClause?.namedBindings;
  if (!declaration || !bindings || !ts.isNamedImports(bindings)) return undefined;
  return { text: declaration.getText(source), bindings: bindings.elements.map((element) => element.name.text) };
}

function withoutConstruction(sourceText: string, fileName: string): string {
  return IMPLEMENTATIONS.reduce((text, implementation) => {
    const construction = constructionImport(text, fileName, implementation);
    if (!construction) return text;
    return construction.bindings.reduce(
      (rest, binding) => rest.replace(new RegExp(`\\b${binding}\\b`, 'g'), ''),
      text.replace(construction.text, ''),
    );
  }, sourceText);
}

const mentions = (sourceText: string, implementations: readonly Implementation[] = IMPLEMENTATIONS): string[] =>
  implementations.flatMap(({ names }) => names.filter((name) => name.test(sourceText)).map((name) => name.source));

function findOffenders(roots: readonly string[]): Record<string, string[]> {
  const offenders: Record<string, string[]> = {};
  for (const root of roots) {
    for (const path of tsFiles(root, { exclude: ['generated'] })) {
      const relPath = relative(root, path);
      if (isTestSupport(relPath)) continue;
      const others = IMPLEMENTATIONS.filter((implementation) => !isImplementation(implementation, relPath));
      const inPath = mentions(relPath, others).length > 0 ? ['file name'] : [];
      const text = readFileSync(path, 'utf8');
      const scanned = relPath === CONSTRUCTION ? withoutConstruction(text, path) : text;
      const found = [...inPath, ...mentions(scanned, others)];
      if (found.length > 0) offenders[relPath] = found;
    }
  }
  return offenders;
}

const [MO2, WABBAJACK] = IMPLEMENTATIONS;

describe('no extension file names a mod manager or a publisher outside its implementation of the Instance adapter', () => {
  it('covers the whole extension source tree and the webview', () => {
    const files = sourceFiles(SOURCE_ROOTS);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(join(WEBVIEW_SRC, 'presentation.ts'));
  });

  it('scans clean outside each implementation', () => {
    expect(findOffenders(SOURCE_ROOTS)).toEqual({});
  });

  it('scans package.json and the walkthrough clean', () => {
    expect([MANIFEST, WALKTHROUGH].map((path) => mentions(readFileSync(path, 'utf8')))).toEqual([[], []]);
  });

  it('scans an implementation\'s files as that implementation\'s alone, and not its interface\'s, the construction\'s or a neutral file\'s', () => {
    expect([
      isImplementation(MO2, join(ADAPTER, 'mo2', 'mo2Instance.ts')),
      isImplementation(MO2, join(ADAPTER, 'mo2', 'codecs', 'modlistText.ts')),
      isImplementation(WABBAJACK, join(ADAPTER, 'wabbajack', 'wabbajackPublisher.ts')),
      isImplementation(MO2, join(ADAPTER, 'wabbajack', 'wabbajackPublisher.ts')),
      isImplementation(MO2, ADAPTER_INTERFACE),
      isImplementation(MO2, CONSTRUCTION),
      isImplementation(MO2, join(ADAPTER, 'files.ts')),
    ]).toEqual([true, true, true, false, false, false, false]);
  });

  it('the construction\'s exemption is load-bearing: the file binds a name from each implementation', () => {
    const path = join(SRC, CONSTRUCTION);
    expect(IMPLEMENTATIONS.map((implementation) => (constructionImport(readFileSync(path, 'utf8'), path, implementation)?.bindings.length ?? 0) > 0))
      .toEqual([true, true]);
  });

  it('holds the construction file to the rule beyond its imports and the names they bind', () => {
    const dir = plantedTree({
      [CONSTRUCTION]: [
        `import { isMo2Instance, mo2InstanceAdapter } from '${entryOf(MO2)}';`,
        `import { wabbajackPublisher } from '${entryOf(WABBAJACK)}';`,
        'export const adapter = mo2InstanceAdapter; export const check = isMo2Instance; export const publisher = wabbajackPublisher;',
        '// MO2 is the manager built here, and Wabbajack the publisher.',
        '',
      ].join('\n'),
    });
    expect(findOffenders([dir])).toEqual({ [CONSTRUCTION]: ['mo2', 'wabbajack'] });
    writeFileSync(join(dir, CONSTRUCTION), `import { isMo2Instance } from '${entryOf(MO2)}';\nexport const check = isMo2Instance;\n`);
    expect(findOffenders([dir])).toEqual({});
  });

  it('catches the name in a comment, a literal or an identifier, and one implementation\'s name in another', () => {
    const dir = plantedTree({
      [join('mods', 'comment.ts')]: '// MO2 sorts these by date.\nexport const x = 1;\n',
      [join('mods', 'tooltip.ts')]: "export const tooltip = 'The files tools wrote while Mod Organizer ran them.';\n",
      [join('plugins', 'command.ts')]: 'export const run = (mo2: { instance: unknown }) => mo2.instance;\n',
      [join('views', 'mo2Trees.ts')]: 'export const trees = [];\n',
      [join('mods', 'identifier.ts')]: 'export const modorganizerRoot = 1;\n',
      [join('mods', 'publisher.ts')]: "export const file = 'Wabbajack compiler_settings.json';\n",
      [join('mods', 'test', 'fixture.ts')]: "export const ini = 'ModOrganizer.ini';\n",
      [join(ADAPTER, 'mo2', 'mo2Instance.ts')]: "export const manager = 'MO2';\n",
      [join(ADAPTER, 'mo2', 'mo2Ignore.ts')]: "export const ignored = 'Wabbajack';\n",
      [join(ADAPTER, 'wabbajack', 'wabbajackPublisher.ts')]: "export const publisher = 'Wabbajack'; export const root = 'ModOrganizer.ini';\n",
      [ADAPTER_INTERFACE]: '// MO2 is one implementation.\n',
      [join(ADAPTER, 'files.ts')]: "import { x } from './mo2/layout';\nexport const y = x;\n",
    });
    expect(findOffenders([dir])).toEqual({
      [join('mods', 'comment.ts')]: ['mo2'],
      [join('mods', 'identifier.ts')]: ['modorganizer'],
      [join('mods', 'tooltip.ts')]: ['\\bMod Organizer\\b'],
      [join('mods', 'publisher.ts')]: ['wabbajack'],
      [join('plugins', 'command.ts')]: ['mo2'],
      [join('views', 'mo2Trees.ts')]: ['file name'],
      [join(ADAPTER, 'mo2', 'mo2Ignore.ts')]: ['wabbajack'],
      [join(ADAPTER, 'wabbajack', 'wabbajackPublisher.ts')]: ['modorganizer'],
      [ADAPTER_INTERFACE]: ['mo2'],
      [join(ADAPTER, 'files.ts')]: ['mo2'],
    });
  });
});
