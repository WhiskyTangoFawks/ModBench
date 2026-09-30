// MO2's watch: every file of the instance, the downloads folder and the game folder's plugins,
// armed through VS Code's file watcher while anyone listens.

import * as vscode from 'vscode';
import type { Subscription } from './instanceAdapter';
import { MODLIST_GLOB, MODS_GLOB, OVERWRITE_GLOB, PLUGINS_GLOB, SETTINGS_WATCH_GLOB } from './layout';

/** A folder the settings name, whose watch moves with them. */
export type FollowedFolder = 'downloadedFiles' | 'gameFolderPlugins';

function isInstanceChange(path: string): boolean {
  const segments = path.split(/[\\/]/);
  const gitIndex = segments.lastIndexOf('.git');
  if (gitIndex === -1) return true;
  const [first, ...rest] = segments.slice(gitIndex + 1);
  if (first === undefined || first === 'refs') return true;
  return rest.length === 0 && (first === 'HEAD' || first === 'packed-refs');
}

// Each change beneath `base` that matches `glob`, created, changed or deleted alike.
function watchFiles(base: string, glob: string, onChange: (path: string) => void): Subscription {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
  const heard = (uri: vscode.Uri): void => onChange(uri.fsPath);
  watcher.onDidCreate(heard);
  watcher.onDidChange(heard);
  watcher.onDidDelete(heard);
  return watcher;
}

interface Followed {
  readonly base: string;
  readonly glob: string;
  watch?: Subscription;
}

export interface Mo2Watch {
  subscribe(listener: () => void): Subscription;
  /** Watches `base` under `glob` for `what` in place of the folder it followed before; undefined
   *  follows none. A watch newly armed signals once, for a change it missed while arming. */
  follow(what: FollowedFolder, base: string | undefined, glob: string): void;
}

export function mo2Watch(instanceRoot: string): Mo2Watch {
  const listeners = new Set<() => void>();
  const followed = new Map<FollowedFolder, Followed>();
  let fixed: Subscription[] = [];

  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const watch = (base: string, glob: string): Subscription =>
    watchFiles(base, glob, (path) => {
      if (isInstanceChange(path)) changed();
    });
  const armed = (): boolean => listeners.size > 0;

  const arm = (): void => {
    fixed = [MODS_GLOB, OVERWRITE_GLOB, MODLIST_GLOB, PLUGINS_GLOB, SETTINGS_WATCH_GLOB].map((glob) => watch(instanceRoot, glob));
    for (const folder of followed.values()) folder.watch = watch(folder.base, folder.glob);
  };
  const disarm = (): void => {
    for (const subscription of fixed) subscription.dispose();
    fixed = [];
    for (const folder of followed.values()) {
      folder.watch?.dispose();
      folder.watch = undefined;
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) arm();
      return {
        dispose: () => {
          if (listeners.delete(listener) && listeners.size === 0) disarm();
        },
      };
    },

    follow(what, base, glob) {
      const current = followed.get(what);
      if (current?.base === base) return;
      current?.watch?.dispose();
      if (base === undefined) {
        followed.delete(what);
        return;
      }
      const next: Followed = { base, glob };
      followed.set(what, next);
      if (!armed()) return;
      next.watch = watch(base, glob);
      changed();
    },
  };
}
