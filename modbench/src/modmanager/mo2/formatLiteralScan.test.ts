// Each MO2 file's format lives in its kernel module, and nothing else names it.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, basename } from 'node:path';
import ts from 'typescript';

const KERNEL_FILES = [
  'modlistText.ts',
  'pluginsText.ts',
  'metaIni.ts',
  'modOrganizerIni.ts',
  'downloads.ts',
  'lineScan.ts',
];
const KERNEL_TESTS = KERNEL_FILES.map((f) => f.replace(/\.ts$/, '.test.ts'));

// The guard's own definition file necessarily holds every token as data (its TOKENS list and
// its rival-plant test); it does not read or write any MO2 file.
const SELF = 'formatLiteralScan.test.ts';

const TOKENS = ['+', '-', '_separator', '*', '[General]', 'selected_profile', 'gameName', 'gamePath', 'installed', 'uninstalled', 'removed'];

// Every string-literal-like node's decoded value — never a substring of a larger literal, and
// never text sitting only in a comment, since comments are trivia the AST does not visit.
function stringLiterals(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function tokenLeaks(sourceText: string, fileName: string): string[] {
  const literals = new Set(stringLiterals(sourceText, fileName));
  return TOKENS.filter((tok) => literals.has(tok));
}

// Every `.ts` file under `dir`, recursively.
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (extname(entry.name) === '.ts') out.push(path);
  }
  return out;
}

function isAllowed(path: string): boolean {
  const name = basename(path);
  if (name === SELF) return true;
  if (!path.includes(join('modmanager', 'mo2'))) return false;
  return KERNEL_FILES.includes(name) || KERNEL_TESTS.includes(name);
}

describe('mo2 kernel format literals', () => {
  it('appear only in their own kernel module or its own test, nowhere else in src', () => {
    const root = join(__dirname, '..', '..'); // src/
    const leaks: Record<string, string[]> = {};
    for (const path of tsFiles(root)) {
      if (isAllowed(path)) continue;
      const found = tokenLeaks(readFileSync(path, 'utf8'), path);
      if (found.length > 0) leaks[path] = found;
    }
    expect(leaks).toEqual({});
  });

  // Rival this catches: a handler that re-derives a format marker (e.g. rebuilding a
  // modlist.txt `+`/`-` line by hand) instead of calling the kernel module that owns it.
  it('flags a literal planted in a non-kernel production file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-format-literal-scan-'));
    try {
      const planted = join(dir, 'notKernel.ts');
      await writeFile(planted, "export const marker = '_separator';\n");
      expect(tokenLeaks(readFileSync(planted, 'utf8'), planted)).toContain('_separator');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The same rival, but in a test file: "and its tests" allows the kernel's OWN test, not
  // every test in the suite.
  it('flags a literal planted in a non-kernel test file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-format-literal-scan-'));
    try {
      const planted = join(dir, 'someOtherComponent.test.ts');
      await writeFile(planted, "const line = (enabled: boolean) => enabled ? '+' : '-';\n");
      expect(tokenLeaks(readFileSync(planted, 'utf8'), planted)).toEqual(expect.arrayContaining(['+', '-']));
      expect(isAllowed(planted)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not flag the same token embedded inside a larger fixture string', () => {
    const src = "const ini = '[General]\\nselected_profile=@ByteArray(Default)\\n';\n";
    expect(tokenLeaks(src, 'x.ts')).toEqual([]);
  });

  it('does not flag a token that appears only inside a comment or a prose test title', () => {
    const src = "// MO2's own `gamePath` key, read elsewhere\nit('the `*` prefix means enabled');\n";
    expect(tokenLeaks(src, 'x.test.ts')).toEqual([]);
  });

  it('allows a kernel module’s own test file', () => {
    expect(isAllowed(join('src', 'modmanager', 'mo2', 'pluginsText.test.ts'))).toBe(true);
  });

  it('does not allow a non-kernel file in mo2/, such as a corpus test', () => {
    expect(isAllowed(join('src', 'modmanager', 'mo2', 'modlistCorpus.test.ts'))).toBe(false);
  });
});
