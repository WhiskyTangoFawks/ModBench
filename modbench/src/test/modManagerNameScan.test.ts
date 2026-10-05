import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { isTestSupport, MO2_CONSTRUCTION as MO2_CONSTRUCTION_SITE, SOURCE_ROOTS, SRC, WEBVIEW_SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const ADAPTER = 'instanceAdapter';
const ADAPTER_INTERFACE = join(ADAPTER, 'instanceAdapter.ts');
const MO2_CONSTRUCTION = MO2_CONSTRUCTION_SITE.file;
const MO2_ENTRY = `./${MO2_CONSTRUCTION_SITE.module.split(sep).join('/')}`;

const NAMES_ANYWHERE_IN_FILE = [/mo2/i, /\bMod Organizer\b/i];

const NAMES_IN_STRING_LITERALS = ['modlist.txt', 'ModOrganizer.ini', 'meta.ini', '.mohidden'];

const isMo2Implementation = (relPath: string): boolean =>
  relPath.startsWith(ADAPTER + sep) && relPath !== ADAPTER_INTERFACE;

function stringLiterals(sourceText: string, fileName: string): string[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function constructionImport(sourceText: string, fileName: string): { text: string; bindings: string[] } | undefined {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === MO2_ENTRY);
  const bindings = declaration?.importClause?.namedBindings;
  if (!declaration || !bindings || !ts.isNamedImports(bindings)) return undefined;
  return { text: declaration.getText(source), bindings: bindings.elements.map((element) => element.name.text) };
}

function withoutConstruction(sourceText: string, fileName: string): string {
  const construction = constructionImport(sourceText, fileName);
  if (!construction) return sourceText;
  return construction.bindings.reduce(
    (text, binding) => text.replace(new RegExp(`\\b${binding}\\b`, 'g'), ''),
    sourceText.replace(construction.text, ''),
  );
}

function managerMentions(sourceText: string, fileName: string): string[] {
  const names = NAMES_ANYWHERE_IN_FILE.filter((name) => name.test(sourceText)).map((name) => name.source);
  const literals = stringLiterals(sourceText, fileName);
  const literalNames = NAMES_IN_STRING_LITERALS.filter((name) => literals.some((literal) => literal.includes(name)));
  return [...names, ...literalNames];
}

function findOffenders(roots: readonly string[]): Record<string, string[]> {
  const offenders: Record<string, string[]> = {};
  for (const root of roots) {
    for (const path of tsFiles(root, { exclude: ['generated'] })) {
      const relPath = relative(root, path);
      if (isMo2Implementation(relPath) || isTestSupport(relPath)) continue;
      const inPath = NAMES_ANYWHERE_IN_FILE.some((name) => name.test(relPath)) ? ['file name'] : [];
      const text = readFileSync(path, 'utf8');
      const scanned = relPath === MO2_CONSTRUCTION ? withoutConstruction(text, path) : text;
      const found = [...inPath, ...managerMentions(scanned, path)];
      if (found.length > 0) offenders[relPath] = found;
    }
  }
  return offenders;
}

async function plantedTree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'medit-manager-name-scan-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

describe('no extension file names MO2 outside its implementation of the Instance adapter', () => {
  it('covers the whole extension source tree and the webview', () => {
    const files = SOURCE_ROOTS.flatMap((root) => tsFiles(root, { exclude: ['generated'] }));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(join(WEBVIEW_SRC, 'presentation.ts'));
  });

  it('scans clean outside the implementation', () => {
    expect(findOffenders(SOURCE_ROOTS)).toEqual({});
  });

  it('scans the implementation\'s files and not its interface\'s as the implementation', () => {
    expect(isMo2Implementation(join(ADAPTER, 'mo2Instance.ts'))).toBe(true);
    expect(isMo2Implementation(join(ADAPTER, 'codecs', 'modlistText.ts'))).toBe(true);
    expect(isMo2Implementation(ADAPTER_INTERFACE)).toBe(false);
  });

  it('the construction\'s exemption is load-bearing: the file imports MO2\'s implementation', () => {
    const path = join(SRC, MO2_CONSTRUCTION);
    expect(constructionImport(readFileSync(path, 'utf8'), path)?.bindings).toEqual(['isMo2Instance', 'mo2InstanceAdapter']);
  });

  it('holds the construction file to the rule beyond its import and the names it binds', async () => {
    const dir = await plantedTree({
      [MO2_CONSTRUCTION]: [
        `import { isMo2Instance, mo2InstanceAdapter } from '${MO2_ENTRY}';`,
        'export const adapter = mo2InstanceAdapter; export const check = isMo2Instance;',
        '// MO2 is the manager built here.',
        "export const say = 'its modlist.txt line could not be written';",
        'export const mo2Side = 1;',
        '',
      ].join('\n'),
    });
    try {
      expect(findOffenders([dir])).toEqual({ [MO2_CONSTRUCTION]: ['mo2', 'modlist.txt'] });
      await writeFile(join(dir, MO2_CONSTRUCTION), `import { isMo2Instance } from '${MO2_ENTRY}';\nexport const check = isMo2Instance;\n`);
      expect(findOffenders([dir])).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('catches the name in a comment or a literal, and a file of the manager\'s in a message', async () => {
    const dir = await plantedTree({
      [join('mods', 'comment.ts')]: '// MO2 sorts these by date.\nexport const x = 1;\n',
      [join('mods', 'tooltip.ts')]: "export const tooltip = 'The files tools wrote while Mod Organizer ran them.';\n",
      [join('mods', 'message.ts')]: 'export const say = (mod: string) => `"${mod}" was created, but its modlist.txt line could not be written.`;\n',
      [join('plugins', 'command.ts')]: 'export const run = (mo2: { instance: unknown }) => mo2.instance;\n',
      [join('views', 'mo2Trees.ts')]: 'export const trees = [];\n',
      [join('mods', 'clean.ts')]: 'export const say = (file: string) => `its ${file} line could not be written.`;\n',
      [join('mods', 'test', 'fixture.ts')]: "export const ini = 'ModOrganizer.ini';\n",
      [join(ADAPTER, 'mo2Instance.ts')]: "export const manager = 'MO2';\n",
      [ADAPTER_INTERFACE]: '// MO2 is one implementation.\n',
    });
    try {
      expect(findOffenders([dir])).toEqual({
        [join('mods', 'comment.ts')]: ['mo2'],
        [join('mods', 'tooltip.ts')]: ['\\bMod Organizer\\b'],
        [join('mods', 'message.ts')]: ['modlist.txt'],
        [join('plugins', 'command.ts')]: ['mo2'],
        [join('views', 'mo2Trees.ts')]: ['file name'],
        [ADAPTER_INTERFACE]: ['mo2'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not flag a file of the manager\'s named in a comment', () => {
    expect(managerMentions('// reads modlist.txt\n', 'x.ts')).toEqual([]);
  });
});
