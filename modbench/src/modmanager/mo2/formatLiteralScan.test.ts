// Each MO2 file's format lives in its kernel module, and nothing else names it.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const KERNEL_FILES = new Set([
  'modlistText.ts',
  'pluginsText.ts',
  'metaIni.ts',
  'modOrganizerIni.ts',
  'downloads.ts',
  'lineScan.ts',
]);

// Quoted both sides by the same quote, so a fixture blob embedding the key inside a larger
// string never counts — only a standalone token used as logic does.
const QUOTES = ["'", '"', '`'];
const TOKENS = ['+', '-', '_separator', '*', '[General]', 'selected_profile', 'gameName', 'gamePath', 'installed', 'uninstalled', 'removed'];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function tokenLeaks(src: string): string[] {
  const code = stripComments(src);
  return TOKENS.filter((tok) => QUOTES.some((q) => code.includes(q + tok + q)));
}

// Non-test, non-generated `.ts` files under `dir`, recursively.
function productionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...productionTsFiles(path));
    } else if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('mo2 kernel format literals', () => {
  it('appear only in their own kernel module, nowhere else in production source', () => {
    const root = join(__dirname, '..', '..'); // src/
    const kernelDir = join('modmanager', 'mo2');
    const leaks: Record<string, string[]> = {};
    for (const path of productionTsFiles(root)) {
      const inKernel = KERNEL_FILES.has(path.split('/').at(-1)!) && path.includes(kernelDir);
      if (inKernel) continue;
      const found = tokenLeaks(readFileSync(path, 'utf8'));
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
      const found = tokenLeaks(readFileSync(planted, 'utf8'));
      expect(found).toContain('_separator');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not flag the same token embedded inside a larger fixture string', () => {
    const found = tokenLeaks("const ini = '[General]\\nselected_profile=@ByteArray(Default)\\n';\n");
    expect(found).toEqual([]);
  });

  it('does not flag a token that appears only inside a comment', () => {
    const found = tokenLeaks("// MO2's own `gamePath` key, read elsewhere\nexport const x = 1;\n");
    expect(found).toEqual([]);
  });
});
