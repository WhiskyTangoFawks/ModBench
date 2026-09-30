// target-architecture.md, Rules the Modbench column draws: only MO2's implementation of the Instance
// adapter names MO2, and a source scan holds it as gameNameScan.test.ts holds game names. Both
// production trees are scanned.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { tsFiles } from './tsFiles';

const SRC = join(__dirname, '..');
const WEBVIEW_SRC = join(__dirname, '..', '..', 'webview', 'src');
const SRC_ROOTS = [SRC, WEBVIEW_SRC];

const ADAPTER = 'instanceAdapter';
// The adapter's interface is every mod manager's, so it names none.
const ADAPTER_INTERFACE = join(ADAPTER, 'instanceAdapter.ts');

// Anywhere in a file's text, comments included.
const MANAGER_NAMES = [/\bMO2\b/, /\bMod Organizer\b/];

// Inside a string literal: the text a user reads.
const MANAGER_FILES = ['modlist.txt', 'ModOrganizer.ini', 'meta.ini'];

const isMo2Implementation = (relPath: string): boolean =>
  relPath.startsWith(ADAPTER + sep) && relPath !== ADAPTER_INTERFACE;

// A test builds a real MO2 instance, and names it; so does a fixture under a `test/` folder.
const isTestSupport = (relPath: string): boolean =>
  relPath.split(sep).some((segment) => segment === 'test' || segment === 'integration') || relPath.includes('.test.');

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

function managerMentions(sourceText: string, fileName: string): string[] {
  const names = MANAGER_NAMES.filter((name) => name.test(sourceText)).map((name) => name.source);
  const literals = stringLiterals(sourceText, fileName);
  const files = MANAGER_FILES.filter((file) => literals.some((literal) => literal.includes(file)));
  return [...names, ...files];
}

// Shared by the production assertion and the planted rivals, so a broken walk fails both alike.
function findOffenders(roots: readonly string[]): Record<string, string[]> {
  const offenders: Record<string, string[]> = {};
  for (const root of roots) {
    for (const path of tsFiles(root, { exclude: ['generated'] })) {
      const relPath = relative(root, path);
      if (isMo2Implementation(relPath) || isTestSupport(relPath)) continue;
      const found = managerMentions(readFileSync(path, 'utf8'), path);
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
    const files = SRC_ROOTS.flatMap((root) => tsFiles(root, { exclude: ['generated'] }));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(join(WEBVIEW_SRC, 'presentation.ts'));
  });

  it('scans clean outside the implementation', () => {
    expect(findOffenders(SRC_ROOTS)).toEqual({});
  });

  // Rival: an exemption grown to the whole box, which lets the interface every manager shares
  // name one of them.
  it('scans the implementation\'s files and not its interface\'s as the implementation', () => {
    expect(isMo2Implementation(join(ADAPTER, 'mo2Instance.ts'))).toBe(true);
    expect(isMo2Implementation(join(ADAPTER, 'codecs', 'modlistText.ts'))).toBe(true);
    expect(isMo2Implementation(ADAPTER_INTERFACE)).toBe(false);
  });

  // Rivals: a comment citing the manager by name, a tooltip spelling it, and a message spelling
  // its mod-order file, each in a nested production file, through the real walk.
  it('catches the name in a comment or a literal, and a file of the manager\'s in a message', async () => {
    const dir = await plantedTree({
      [join('mods', 'comment.ts')]: '// MO2 sorts these by date.\nexport const x = 1;\n',
      [join('mods', 'tooltip.ts')]: "export const tooltip = 'The files tools wrote while Mod Organizer ran them.';\n",
      [join('mods', 'message.ts')]: 'export const say = (mod: string) => `"${mod}" was created, but its modlist.txt line could not be written.`;\n',
      [join('mods', 'clean.ts')]: 'export const say = (file: string) => `its ${file} line could not be written.`;\n',
      [join('mods', 'test', 'fixture.ts')]: "export const ini = 'ModOrganizer.ini';\n",
      [join(ADAPTER, 'mo2Instance.ts')]: "export const manager = 'MO2';\n",
      [ADAPTER_INTERFACE]: '// MO2 is one implementation.\n',
    });
    try {
      expect(findOffenders([dir])).toEqual({
        [join('mods', 'comment.ts')]: ['\\bMO2\\b'],
        [join('mods', 'tooltip.ts')]: ['\\bMod Organizer\\b'],
        [join('mods', 'message.ts')]: ['modlist.txt'],
        [ADAPTER_INTERFACE]: ['\\bMO2\\b'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not flag an identifier that only begins with the name, nor a file name in a comment', () => {
    expect(managerMentions('import { mo2Watch } from "./mo2Watch";\n// reads modlist.txt\n', 'x.ts')).toEqual([]);
  });
});
