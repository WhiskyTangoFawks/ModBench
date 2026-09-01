import * as vscode from 'vscode';
import { detectGamePaths } from './medit/GamePathDetector';
import type { DetectPaths } from './modmanager/gameDirectory';
import { mo2InstanceContext } from './modmanager/detectMo2Instance';

/** Three small, genuinely neutral facts about the current workspace that both bounded contexts
 *  read — none of them carry a "mod"/"record" vocabulary of their own, so this file, not the
 *  composition root, is where they belong. A registrar file importing back from `extension.ts`
 *  would contradict the composition-root framing the split itself claims (#628 review) — these
 *  used to live there only because that was the one file everything else was already in. */
export const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** Game-path resolver: explicit `game.*` overrides if both set, else autodetect.
 *  Shared by the deploy commands and editing launch. */
export function makeDetectPaths(): DetectPaths {
  return () => {
    const c = meditConfig();
    const dataOverride = (c.get('game.dataFolderPath') as string) ?? '';
    const pluginsOverride = (c.get('game.pluginsTxtPath') as string) ?? '';
    if (dataOverride && pluginsOverride) {
      return Promise.resolve({ dataFolder: dataOverride, pluginsTxt: pluginsOverride });
    }
    return detectGamePaths(process.platform);
  };
}

/** The only place either MO2-instance context key is set — see mo2InstanceContext's own
 *  comment for why the two keys must always travel together. Every registerLoadoutView exit
 *  path (no workspace, not an instance, valid instance) calls this instead of `setContext`
 *  directly. */
export function setMo2InstanceContext(isInstance: boolean): void {
  for (const [key, value] of Object.entries(mo2InstanceContext(isInstance))) {
    void vscode.commands.executeCommand('setContext', key, value);
  }
}
