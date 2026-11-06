import { papyrusScriptAt } from '../tables/gamePaths';
import type { FileWinners } from './fileConflictIndex';

/** A Papyrus script, and the file Go to Definition opens for it. */
export interface PapyrusScript {
  readonly name: string;
  readonly file: string;
}

/** Each Papyrus script an enabled mod or Overwrite holds, by name: the winning copy of its source in the first source
 *  folder that holds one, else of its compiled script. */
export function papyrusScriptsOf(files: FileWinners, release: string | undefined): PapyrusScript[] {
  const best = new Map<string, PapyrusScript & { readonly preference: number }>();
  for (const { relativePath, winner } of files.values()) {
    const script = papyrusScriptAt(release, relativePath);
    if (script === undefined) continue;
    const key = script.name.toLowerCase();
    const held = best.get(key);
    if (held === undefined || script.preference < held.preference) best.set(key, { name: script.name, file: winner, preference: script.preference });
  }
  return [...best.values()].map(({ name, file }) => ({ name, file })).sort((a, b) => a.name.localeCompare(b.name));
}
