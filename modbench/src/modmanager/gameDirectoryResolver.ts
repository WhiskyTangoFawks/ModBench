// #357: the game directory used to have two resolution sites with different lifetimes — an
// activation-scoped Promise threaded to the Loadout views, and a handful of per-call sites that
// re-resolved fresh. `modbench.mods.gameDirectory` is editable while Modbench runs, so the two
// could name different folders and a new consumer had no way to tell which one was safe to reach
// for. This resolver removes the choice: memoised, invalidated only when the setting itself
// changes, and the one thing every consumer (views, session launch, deploy) calls through.
//
// Pure over injected config/detection/change-notification, like `gameDirectory.ts` itself — no
// vscode import, unit-testable without a VS Code harness.

import { resolveGameDirectory, type ConfigLike, type DetectPaths, type GameDirectory } from './gameDirectory';

/** Minimal stand-in for vscode's `ConfigurationChangeEvent`. */
export interface ConfigChangeEvent {
  affectsConfiguration(section: string): boolean;
}

/** Matches `vscode.workspace.onDidChangeConfiguration`'s single-listener-arg overload exactly, so
 *  the composition root can pass it straight through with no adapter. */
export type OnConfigChange = (listener: (e: ConfigChangeEvent) => void) => { dispose(): void };

export interface GameDirectoryResolver {
  /** Memoised: repeated calls return the same in-flight/settled resolution until the setting
   *  changes. A rejection (e.g. an explicit `gameDirectory` with no `Data/`) is cached too, same
   *  as a settled value — callers see the same failure until the setting changes, matching what
   *  every existing call site already tolerated. */
  resolve(): Promise<GameDirectory | null>;
  dispose(): void;
}

/** The setting whose edit can make a memoised answer stale. Detection inputs (the MO2 ini,
 *  autodetect) are out of #357's scope — only this setting is watched. */
const WATCHED_SECTION = 'modbench.mods.gameDirectory';

export function createGameDirectoryResolver(
  instanceRoot: string,
  config: () => ConfigLike,
  detectPaths: DetectPaths,
  onConfigChange: OnConfigChange,
): GameDirectoryResolver {
  let cached: Promise<GameDirectory | null> | undefined;

  const subscription = onConfigChange((e) => {
    if (e.affectsConfiguration(WATCHED_SECTION)) cached = undefined;
  });

  return {
    resolve: () => {
      cached ??= resolveGameDirectory(instanceRoot, config(), detectPaths);
      return cached;
    },
    dispose: () => subscription.dispose(),
  };
}
