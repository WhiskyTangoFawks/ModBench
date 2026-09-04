// `modbench.mods.gameDirectory` is editable while Modbench runs, so two resolution sites with
// different lifetimes could name different folders. This is the only one, and it is pure over
// injected config and detection — no vscode import.

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
  /** Memoised until the setting changes; a rejection is cached exactly as a settled value is. */
  resolve(): Promise<GameDirectory | null>;
  dispose(): void;
}

// Detection inputs (the MO2 ini, autodetect) are deliberately not watched; only this setting is.
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

/** Degrades a failed resolution to `undefined` for views that cannot propagate it. Keying the
 *  fold on the resolver's promise identity, rather than a second cache, stops one misconfigured
 *  setting logging once per read. */
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
