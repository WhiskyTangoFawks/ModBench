// The single resolution site for the game directory. `modbench.mods.gameDirectory` is editable
// while Modbench runs, so two independent resolution sites with different lifetimes could name
// different folders, with no way for a consumer to tell which was safe to reach for. This
// resolver removes the choice: memoised, invalidated only when the setting itself changes, and
// the one thing every consumer (views, load order launch, deploy) calls through.
//
// Pure over injected config/detection/change-notification, like `gameDirectory.ts` itself — no
// vscode import, unit-testable without a VS Code harness.

import {
  resolveGameDirectory,
  type ConfigLike,
  type DetectPaths,
  type DetectWinePrefix,
  type GameDirectory,
} from './gameDirectory';

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
 *  autodetect) are deliberately not watched — only this setting is. */
const WATCHED_SECTION = 'modbench.mods.gameDirectory';

export function createGameDirectoryResolver(
  instanceRoot: string,
  config: () => ConfigLike,
  detectPaths: DetectPaths,
  detectWinePrefix: DetectWinePrefix,
  onConfigChange: OnConfigChange,
): GameDirectoryResolver {
  let cached: Promise<GameDirectory | null> | undefined;

  const subscription = onConfigChange((e) => {
    if (e.affectsConfiguration(WATCHED_SECTION)) cached = undefined;
  });

  return {
    resolve: () => {
      cached ??= resolveGameDirectory(instanceRoot, config(), detectPaths, detectWinePrefix);
      return cached;
    },
    dispose: () => subscription.dispose(),
  };
}

/** Wraps a resolver into a `dataFolder` getter for consumers (the Loadout views) that degrade a
 *  failed/absent resolution to `undefined` rather than propagate it — `ModListProvider`,
 *  `PluginListProvider` and `ImplicitMasterDecorationProvider`'s `dataFolder` option.
 *
 *  The fold's log side effect is memoised by the resolver's own cache generation
 *  (referential identity of the promise `resolve()` currently returns), not re-run per read. A
 *  naive `resolve().then().catch()` on every call would re-run `onError` on every read of the
 *  same cached rejection — `ImplicitMasterDecorationProvider` alone reads it once per visible
 *  file — turning a misconfigured setting that never changes into a repeat-logged error instead
 *  of a single log. Riding the resolver's own cache
 *  identity keeps this on the resolver's one lifeline, rather than a second independent
 *  cache with its own invalidation to keep in sync. */
export function dataFolderFrom(
  resolver: Pick<GameDirectoryResolver, 'resolve'>,
  onError: (e: unknown) => void,
): () => Promise<string | undefined> {
  let lastResolution: Promise<GameDirectory | null> | undefined;
  let folded: Promise<string | undefined> | undefined;

  return () => {
    const resolution = resolver.resolve();
    if (resolution !== lastResolution) {
      lastResolution = resolution;
      folded = resolution.then((gd) => gd?.dataFolder).catch((e: unknown) => {
        onError(e);
        return undefined;
      });
    }
    return folded!;
  };
}
