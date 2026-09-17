import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface TsFilesOptions {
  /** Directory names never descended into, in addition to `node_modules`. */
  exclude?: string[];
  /** Whether `.tsx` counts alongside `.ts`. Defaults to `true`. */
  tsx?: boolean;
  /** Whether a `*.test.ts` file counts. Defaults to `true`. */
  includeTests?: boolean;
}

/** Every `.ts`/`.tsx` file under `dir`, recursive. The one walker every scan test shares, so a
 *  scan's own filter is its whole reason to exist. */
export function tsFiles(dir: string, options: TsFilesOptions = {}): string[] {
  const exclude = new Set(['node_modules', ...(options.exclude ?? [])]);
  const tsx = options.tsx ?? true;
  const includeTests = options.includeTests ?? true;
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFiles(path, options));
      continue;
    }
    const ext = extname(entry.name);
    if (ext !== '.ts' && !(tsx && ext === '.tsx')) continue;
    if (!includeTests && entry.name.endsWith('.test.ts')) continue;
    out.push(path);
  }
  return out;
}
