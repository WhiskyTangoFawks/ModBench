// Each MO2 file's format lives in its kernel module, and nothing else names it.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, basename } from 'node:path';
import ts from 'typescript';

const KERNEL_FILES = ['modlistText.ts', 'pluginsText.ts', 'metaIni.ts', 'modOrganizerIni.ts', 'downloads.ts'];
const KERNEL_TESTS = KERNEL_FILES.map((f) => f.replace(/\.ts$/, '.test.ts'));

// The guard's own definition file necessarily holds every token as data (its TOKENS list and
// its rival-plant test); it does not read or write any MO2 file.
const SELF = 'formatLiteralScan.test.ts';

const TOKENS = ['+', '-', '_separator', '*', '[General]', 'selected_profile', 'gameName', 'gamePath', 'installed', 'uninstalled', 'removed'];

// Every string-literal-like node's decoded value, plus a template's head — never a substring of
// a larger literal, and never text sitting only in a comment, since comments are trivia the AST
// does not visit.
function stringLiterals(sourceText: string, fileName: string): string[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function tokenLeaks(sourceText: string, fileName: string): string[] {
  const literals = new Set(stringLiterals(sourceText, fileName));
  return TOKENS.filter((tok) => literals.has(tok));
}

// Every `.ts`/`.tsx` file under `dir`, recursively.
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') out.push(path);
  }
  return out;
}

function isAllowed(path: string): boolean {
  const name = basename(path);
  if (name === SELF) return true;
  if (!path.includes(join('modmanager', 'mo2'))) return false;
  return KERNEL_FILES.includes(name) || KERNEL_TESTS.includes(name);
}

// Shared by the production assertion and the rival tests below, so a broken walk — a wrong root,
// an excluded directory or extension — fails both the same way, not just the matcher.
function findLeaks(root: string): Record<string, string[]> {
  const leaks: Record<string, string[]> = {};
  for (const path of tsFiles(root)) {
    if (isAllowed(path)) continue;
    const found = tokenLeaks(readFileSync(path, 'utf8'), path);
    if (found.length > 0) leaks[path] = found;
  }
  return leaks;
}

describe('mo2 kernel format literals', () => {
  it('covers the whole extension source tree', () => {
    const root = join(__dirname, '..', '..'); // src/
    expect(tsFiles(root).length).toBeGreaterThan(100);
  });

  // Rival: a KERNEL_FILES entry renamed, deleted, or never naming its own marker — proof the
  // list is load-bearing, not decorative.
  it('every kernel file exists and names at least one token', () => {
    const root = join(__dirname, '..', '..'); // src/
    for (const file of KERNEL_FILES) {
      const path = join(root, 'modmanager', 'mo2', file);
      const found = tokenLeaks(readFileSync(path, 'utf8'), path);
      expect(found.length).toBeGreaterThan(0);
    }
  });

  it('appear only in their own kernel module or its own test, nowhere else in src', () => {
    const root = join(__dirname, '..', '..'); // src/
    expect(findLeaks(root)).toEqual({});
  });

  // Rival this catches: a handler re-deriving a format marker by hand instead of calling the
  // kernel module that owns it. Nested, so the real walk's recursion is exercised too.
  it('the tree walk itself catches a literal planted in a nested non-kernel production file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-format-literal-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'topLevel.ts'), "export const label = 'unrelated';\n");
      const planted = join(dir, 'nested', 'notKernel.ts');
      await writeFile(planted, "export const marker = '_separator';\n");
      expect(findLeaks(dir)).toEqual({ [planted]: ['_separator'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The walk covers `.tsx` too, not only `.ts`.
  it('the tree walk itself catches a literal planted in a nested .tsx file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-format-literal-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      const planted = join(dir, 'nested', 'notKernel.tsx');
      await writeFile(planted, "export const marker = '_separator';\n");
      expect(findLeaks(dir)).toEqual({ [planted]: ['_separator'] });
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

  it('collects a template head as well as a no-substitution template', () => {
    const src = 'const a = `_separator${suffix}`;\nconst b = `+`;\n';
    expect(tokenLeaks(src, 'x.ts')).toEqual(expect.arrayContaining(['_separator', '+']));
  });

  it('allows a kernel module’s own test file', () => {
    expect(isAllowed(join('src', 'modmanager', 'mo2', 'pluginsText.test.ts'))).toBe(true);
  });

  it('does not allow a non-kernel file in mo2/, such as a corpus test', () => {
    expect(isAllowed(join('src', 'modmanager', 'mo2', 'modlistCorpus.test.ts'))).toBe(false);
  });

  // Rival: lineScan.ts resurrected in the list — it holds no format token of its own, only the
  // shared EOL/splice machinery every kernel module calls.
  it('lineScan.ts is not (and cannot honestly be) a kernel file', () => {
    expect(KERNEL_FILES).not.toContain('lineScan.ts');
    const text = readFileSync(join(__dirname, 'lineScan.ts'), 'utf8');
    expect(tokenLeaks(text, 'lineScan.ts')).toEqual([]);
  });
});
