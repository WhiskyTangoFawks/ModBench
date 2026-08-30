import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** An MO2 instance is the folder containing `ModOrganizer.ini` alongside `mods/`
 *  and `profiles/` (modbench/CLAUDE.md invariant: workspace root = MO2
 *  instance). Checks structural presence only — never reads file contents — so
 *  a real instance with a corrupt/unreadable `modlist.txt` still reads `true`
 *  here and surfaces as a genuine error elsewhere (ADR-0026), not a
 *  wrong-folder message (issue #192). */
export function isMo2Instance(root: string): boolean {
  return existsSync(join(root, 'ModOrganizer.ini'))
    && existsSync(join(root, 'mods'))
    && existsSync(join(root, 'profiles'));
}

/** #554: the welcome's `when` clause can't tell "unset" from "checked, and it's false" through
 *  a plain context key — VS Code's when-clause parser collapses a bare-boolean `== false` to the
 *  same expression as `!key`, and an unset key reads falsy either way. modbench.workspaceMo2CheckDone
 *  is a second key, always `true` here regardless of the verdict, that exists only to be unset
 *  before the check has run. The two keys always travel together: this is the one place that
 *  decides either value, so every extension.ts exit path calls this instead of setContext
 *  directly — a future exit path can't set one key without the other. */
export function mo2InstanceContext(isInstance: boolean): Record<string, boolean> {
  return {
    'modbench.workspaceIsMo2Instance': isInstance,
    'modbench.workspaceMo2CheckDone': true,
  };
}
