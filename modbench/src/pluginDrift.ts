import * as vscode from 'vscode';

/** Where a plugin name resolves to right now, or `null` for a name nothing provides any more.
 *  Structurally the `ResolvedOrigin` that `modmanager/explicitSession.ts` produces, restated here
 *  rather than imported: this module belongs to neither bounded context and imports from neither
 *  (`src/test/contextBoundary.test.ts`), the same rule `PluginsTreeComposite` and `nameFilter`
 *  keep. An origin is an opaque string on both sides of the boundary — ADR-0036 makes that the
 *  point, not a concession. */
export type ResolvedOrigin = { origin: string; path: string } | null;

/** A plugin whose name no longer resolves to the file its records were read from (#279 /
 *  [ADR-0035](../../docs/adr/0035-one-plugins-tree-editing-is-a-capability.md) § Live mutation).
 *  `currentOrigin: null` is the "would now resolve to: nothing" case — uninstalling the only
 *  provider of a loaded plugin — where there is nothing left to re-read. */
export interface PluginDrift {
  /** The origin the session's copy of this plugin was read from. */
  loadedOrigin: string;
  /** The origin its name resolves to now, or `null` for nothing. */
  currentOrigin: string | null;
  /** The file to re-read, or `null` when there is none. */
  currentPath: string | null;
}

export interface DriftTrackerDeps {
  /** Mod Management's answer for a set of plugin names: case-folded name → where it resolves now.
   *  Injected rather than imported, which is what lets this module import from neither context —
   *  `extension.ts` wires `resolveCurrentPluginOrigins` in. A name that resolves to nothing must
   *  come back as a key with a `null` value; an *absent* key means "no answer for this one", which
   *  is treated as unknown rather than as no drift. */
  currentOrigins: (names: string[]) => Promise<Map<string, ResolvedOrigin>>;
  log: (msg: string) => void;
}

export interface DriftTracker extends vscode.Disposable {
  /** The session's hand-off: each held plugin's filename → the origin it was loaded from, or
   *  `undefined` when there is no session. Clearing drops every marker without asking Mod
   *  Management anything — with no loaded origin there is nothing a current origin could differ
   *  from, so a walk would be work whose answer could not mean anything. */
  setLoaded(loadedOrigins: Map<string, string> | undefined): void;
  /** Recompute against what the loadout says now. Wired to Mod Management's own watchers
   *  (`extension.ts`) — never a timer. */
  refresh(): Promise<void>;
  /** This plugin's drift, or `undefined` for a plugin that has not drifted **or** that nothing is
   *  known about. Those two are deliberately one value: see `refresh` for why the caller must not
   *  be able to tell them apart by accident. */
  driftOf(pluginFile: string): PluginDrift | undefined;
  /** Fires when the drift set may have changed, so the tree can re-render. */
  onDidChange: vscode.Event<void>;
}

/** Drift, computed where the two bounded contexts are allowed to meet.
 *
 *  Drift is a comparison between two facts that must not live in one place: **where a plugin's
 *  records were read from** (the session's `PluginMetadata.Origin` — Editing's) and **where its
 *  name resolves now** (`mods/` plus Modlist priority — Mod Management's). ADR-0035 gives the row,
 *  and therefore drift, to Mod Management; Editing never learns that mods exist. So the comparison
 *  happens here, at the composition root, over two injected functions — the same shape
 *  `PluginsTreeComposite` and `nameFilter` already use, and the reason all three live in `src/`
 *  rather than in either context's folder.
 *
 *  **Why this is not a `FileDecorationProvider`.** #331's pending-change decorations are one, and
 *  #279 was specified to match them. It cannot: a `TreeItem` has exactly one `resourceUri`, #331
 *  already claims plugin rows' for its `medit-pending-plugin:` scheme, and VS Code renders a single
 *  badge per row across all providers — so a drift provider would have to answer for a scheme named
 *  after the other context's pending changes, and then fight #331 for the badge on any row that has
 *  both. Drift therefore renders through `PluginsTreeComposite`'s own icon/description/tooltip path,
 *  where #277's master issues and #277's load failures already render, and where AC3's tooltip
 *  requirement has to land anyway. This is a platform limitation, which is the one carve-out
 *  Native-first allows (`modbench/CLAUDE.md`) — not a preference, and not an oversight to
 *  "fix" back into a badge. */
export function createDriftTracker(deps: DriftTrackerDeps): DriftTracker {
  const emitter = new vscode.EventEmitter<void>();
  /** Case-folded plugin filename → the origin the session loaded it from. `undefined` = no
   *  session, which is different from an empty session and is why this is not just an empty Map. */
  let loaded: Map<string, string> | undefined;
  /** The *display* filenames, in session order, so Mod Management is asked using the names it
   *  would itself use rather than the folded keys. */
  let loadedNames: string[] = [];
  let drifted = new Map<string, PluginDrift>();

  const fold = (name: string) => name.toLowerCase();

  const clear = () => {
    const had = drifted.size > 0;
    drifted = new Map();
    return had;
  };

  return {
    setLoaded(loadedOrigins) {
      loaded = loadedOrigins && new Map([...loadedOrigins].map(([name, origin]) => [fold(name), origin]));
      loadedNames = loadedOrigins ? [...loadedOrigins.keys()] : [];
      if (loaded === undefined) clear();
      emitter.fire();
    },

    async refresh() {
      if (loaded === undefined) return;
      const held = loaded;

      let current: Map<string, ResolvedOrigin>;
      try {
        current = await deps.currentOrigins(loadedNames);
      } catch (e) {
        // #334: an absent drift marker must never be produced by a failed computation. "No drift"
        // and "could not tell" render identically on a row, so the failed answer is discarded and
        // whatever was last *known* stays — stale-but-honest over confidently-blank. Nothing is
        // toasted: this runs off a filesystem watcher, which is ADR-0026's background/recoverable
        // tier, and a mods/ walk that fails during an install will succeed on the next event.
        deps.log(`[pluginDrift] could not resolve current plugin origins — keeping the last known drift state: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      // A session close that landed while the walk was in flight owns the answer, not this walk.
      if (loaded !== held) return;

      const next = new Map<string, PluginDrift>();
      for (const [file, loadedOrigin] of held) {
        // `has` before `get`: a name Mod Management did not answer for at all is unknown, and
        // unknown must not read as "resolves to nothing" — that would flag a drift-to-nothing on
        // every plugin a partial answer omitted.
        if (!current.has(file)) continue;
        const resolved = current.get(file)!;
        if (resolved !== null && fold(resolved.origin) === fold(loadedOrigin)) continue;
        next.set(file, {
          loadedOrigin,
          currentOrigin: resolved?.origin ?? null,
          currentPath: resolved?.path ?? null,
        });
      }

      drifted = next;
      emitter.fire();
    },

    driftOf: (pluginFile) => drifted.get(fold(pluginFile)),
    onDidChange: emitter.event,
    dispose: () => emitter.dispose(),
  };
}
