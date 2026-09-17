import { existsSync } from 'node:fs';
import { modsDir, profilesDir, settingsFile } from '../mo2Codecs/layout';

/** Structural presence only, never file contents: a real instance with a corrupt
 *  `modlist.txt` still reads `true` here and surfaces its error elsewhere (ADR-0019)
 *  rather than as a wrong-folder message. */
export function isMo2Instance(root: string): boolean {
  return existsSync(settingsFile(root))
    && existsSync(modsDir(root))
    && existsSync(profilesDir(root));
}

/** VS Code's when-clause parser collapses `key == false` into `!key`, so an unset key and a
 *  false one are indistinguishable; the always-`true` second key exists only to be unset
 *  before the check has run. */
export function mo2InstanceContext(isInstance: boolean): Record<string, boolean> {
  return {
    'modbench.workspaceIsMo2Instance': isInstance,
    'modbench.workspaceMo2CheckDone': true,
  };
}
