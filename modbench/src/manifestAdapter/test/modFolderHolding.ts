import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

/** A folder named `Mod`, for the length of one test, holding each of `files`, a text by its name. */
export function modFolderHolding(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'modbench-mod-'));
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }); });
  const folder = join(root, 'Mod');
  mkdirSync(folder);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  return folder;
}
