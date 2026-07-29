import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** An MO2 instance is the folder containing `ModOrganizer.ini` alongside `mods/`
 *  and `profiles/` (modmanager/CONTEXT.md invariant: workspace root = MO2
 *  instance). Checks structural presence only — never reads file contents — so
 *  a real instance with a corrupt/unreadable `modlist.txt` still reads `true`
 *  here and surfaces as a genuine error elsewhere (ADR-0026), not a
 *  wrong-folder message (issue #192). */
export function isMo2Instance(root: string): boolean {
  return existsSync(join(root, 'ModOrganizer.ini'))
    && existsSync(join(root, 'mods'))
    && existsSync(join(root, 'profiles'));
}
