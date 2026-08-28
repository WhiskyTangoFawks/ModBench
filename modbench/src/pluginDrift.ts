import * as vscode from 'vscode';

/** Where a plugin name resolves to right now, or `null` for a name nothing provides any more.
 *  Structurally the `ResolvedOrigin` that `modmanager/explicitSession.ts` produces, restated here
 *  rather than imported: this module belongs to neither bounded context and imports from neither
 *  (`src/test/contextBoundary.test.ts`), the same rule `PluginsTreeComposite` and `nameFilter`
 *  keep. An origin is an opaque string on both sides of the boundary — ADR-0036 makes that the
 *  point, not a concession. */
export type ResolvedOrigin = { origin: string; path: string } | null;

/** A plugin whose name no longer resolves to the file its records were read from (#279 / #356 /
 *  [ADR-0035](../../docs/adr/0035-one-plugins-tree-editing-is-a-capability.md) § Live mutation,
 *  2026-08-17 amendment). `currentOrigin: null` is the "would now resolve to: nothing" case —
 *  uninstalling the only provider of a loaded plugin — where there is nothing left to re-read. */
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
  /** #356 / ADR-0035's 2026-08-17 amendment: re-reads one plugin from the copy its name resolves
   *  to now — `SessionController.rereadPlugin`, wired in `extension.ts`. Injected the same way
   *  `currentOrigins` is, for the same reason: this is where Editing's half of the absorption is
   *  reached without this module importing either bounded context. Returns whether it happened;
   *  a rejection is treated the same as `false` — the caller (`SessionController`) already
   *  reports and logs its own failures, so this module only needs the outcome. */
  reread: (plugin: string, path: string, origin: string) => Promise<boolean>;
  log: (msg: string) => void;
}

export interface DriftTracker extends vscode.Disposable {
  /** The session's hand-off: each held plugin's filename → the origin it was loaded from, or
   *  `undefined` when there is no session. Clearing drops every marker without asking Mod
   *  Management anything — with no loaded origin there is nothing a current origin could differ
   *  from, so a walk would be work whose answer could not mean anything. */
  setLoaded(loadedOrigins: Map<string, string> | undefined): void;
  /** Recompute against what the loadout says now, and absorb what changed: every plugin whose
   *  name resolves to a different file than it was loaded from is re-read automatically (#356 /
   *  ADR-0035's 2026-08-17 amendment) — no decoration, no confirmation, no user gesture. Wired to
   *  Mod Management's own watchers (`extension.ts`), never a timer.
   *
   *  Serialized: overlapping calls (the modlist and mods watchers can both fire for one mod-level
   *  change, per their own doc comments) run one at a time rather than racing two absorption
   *  passes over the same plugin — see this module's own `refresh` for how. */
  refresh(): Promise<void>;
}

const fold = (name: string) => name.toLowerCase();

/** The comparison itself: every held plugin whose name no longer resolves to the origin it was
 *  loaded from. Neither map's casing is authoritative — plugins.txt and the folders behind an
 *  origin both come off a case-insensitive filesystem in practice. */
function compare(
  held: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, ResolvedOrigin>,
): Map<string, PluginDrift> {
  const drifted = new Map<string, PluginDrift>();
  for (const [file, loadedOrigin] of held) {
    // `has` before reading the value: a name the answer did not cover at all is *unknown*, and
    // unknown must not read as "resolves to nothing" — that would flag a drift-to-nothing on
    // every plugin a partial answer happened to omit (#334, one row wide).
    if (!current.has(file)) continue;
    const resolved = current.get(file)!;
    if (resolved !== null && fold(resolved.origin) === fold(loadedOrigin)) continue;
    drifted.set(file, {
      loadedOrigin,
      currentOrigin: resolved?.origin ?? null,
      currentPath: resolved?.path ?? null,
    });
  }
  return drifted;
}

/** A tracker instance's mutable state, split out of `createDriftTracker`'s own closure so
 *  `absorbOne`/`doRefresh` below can be ordinary top-level functions taking it as a parameter
 *  instead of closing over it — the only reason for the split is keeping `createDriftTracker`
 *  itself under this codebase's function-length lint budget; there is no behavioral reason one
 *  instance's state couldn't just be closure variables the way it used to be. */
interface DriftState {
  /** Case-folded plugin filename → the origin the session loaded it from. `undefined` = no
   *  session, which is different from an empty session and is why this is not just an empty Map.
   *  Mutated in place by a successful absorption (`absorbOne`) rather than replaced, so a
   *  `refresh()` in flight and the tracker's own idea of "loaded" never disagree about identity —
   *  only `setLoaded` ever assigns a *new* Map to this field. */
  loaded: Map<string, string> | undefined;
  /** Case-folded filename → the display name Mod Management would use for it, so absorption calls
   *  `deps.reread` with the same casing the row and the session already agree on. */
  originalNameByFold: Map<string, string> | undefined;
  /** The *display* filenames, in session order, so Mod Management is asked using the names it
   *  would itself use rather than the folded keys. */
  loadedNames: string[];
}

/** Absorbs one drifted entry against `held` (the pass's own baseline, not necessarily `state`'s
 *  current `loaded` by the time this returns): re-reads it if there is something to read, and
 *  folds a success straight back into `held` so a later pass — triggered by the next mod-level
 *  change, not this one — sees it as no longer drifted. Without that fold, every future mod-level
 *  change anywhere would find this plugin still "drifted" against its stale original baseline and
 *  re-read it again, forever.
 *
 *  Returns whether `doRefresh`'s loop should keep going: `false` only when a session close or a
 *  fresh load landed mid-absorption, in which case `held` is an orphaned pass no one is waiting on
 *  and reading a further plugin for it would only waste work. */
async function absorbOne(
  deps: DriftTrackerDeps, state: DriftState, file: string, drift: PluginDrift, held: Map<string, string>,
): Promise<boolean> {
  // Uninstalling the only provider of a loaded plugin: the name resolves to nothing, there is
  // nothing to read, and the loaded records stay browsable exactly as they are. This is the one
  // drift no absorption can repair, so it is left alone — permanently, until either a provider
  // reappears or the plugin leaves the load order (neither this module's concern).
  if (drift.currentPath === null || drift.currentOrigin === null) return true;

  const plugin = state.originalNameByFold?.get(file) ?? file;
  let absorbed: boolean;
  try {
    absorbed = await deps.reread(plugin, drift.currentPath, drift.currentOrigin);
  } catch (e) {
    deps.log(`[pluginDrift] absorbing "${plugin}"'s origin change threw: ${e instanceof Error ? e.message : String(e)}`);
    absorbed = false;
  }

  // A session close or a fresh load landing mid-absorption owns the answer, not this pass.
  if (state.loaded !== held) return false;

  if (absorbed) {
    deps.log(`[pluginDrift] absorbed "${plugin}": ${drift.loadedOrigin} → ${drift.currentOrigin}`);
    held.set(file, drift.currentOrigin);
  }
  // A failed re-read leaves `held` exactly as it was: the comparison still calls this plugin
  // drifted, and the next mod-level event tries again — there is no internal retry loop here,
  // matching the rest of this module's "no polling" posture.
  return true;
}

/** One absorption pass: recompute drift against `state.loaded`, then hand every entry to
 *  `absorbOne`. */
async function doRefresh(deps: DriftTrackerDeps, state: DriftState): Promise<void> {
  if (state.loaded === undefined) return;
  const held = state.loaded;

  let current: Map<string, ResolvedOrigin>;
  try {
    current = await deps.currentOrigins(state.loadedNames);
  } catch (e) {
    // #334: absorption must never act on a failed computation. Nothing is re-read this pass; the
    // next mod-level event tries again. Nothing is toasted: this runs off a filesystem watcher
    // (ADR-0026's background/recoverable tier), and a mods/ walk that fails during an install will
    // succeed on the next event.
    deps.log(`[pluginDrift] could not resolve current plugin origins — leaving plugins as they are: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // A session close (or a fresh load) that landed while the walk was in flight owns the answer,
  // not this pass — `state.loaded` was reassigned to a new Map, so identity, not content, is the
  // test.
  if (state.loaded !== held) return;

  for (const [file, drift] of compare(held, current)) {
    if (!(await absorbOne(deps, state, file, drift, held))) return;
  }
}

/** Origin drift, absorbed where the two bounded contexts are allowed to meet.
 *
 *  Drift is a comparison between two facts that must not live in one place: **where a plugin's
 *  records were read from** (the session's `PluginMetadata.Origin` — Editing's) and **where its
 *  name resolves now** (`mods/` plus Modlist priority — Mod Management's). ADR-0035's 2026-08-17
 *  amendment gives the reaction to it, too: the session re-reads the plugin automatically, the
 *  same absorption every other loadout gesture already gets. So the comparison *and* the reaction
 *  both happen here, at the composition root, over two injected functions — the same shape
 *  `PluginsTreeComposite` and `nameFilter` already use, and the reason all three live in `src/`
 *  rather than in either context's folder.
 *
 *  #356 retired the manual gesture this used to feed (a `⚠ Drifted` decoration and a per-row
 *  Re-read command) — "drift" is not a concept a user needs to know; it was inventory of a refusal
 *  this design no longer makes. What is left is purely the detect-and-absorb engine. */
export function createDriftTracker(deps: DriftTrackerDeps): DriftTracker {
  const state: DriftState = { loaded: undefined, originalNameByFold: undefined, loadedNames: [] };

  // Serializes `refresh()` calls so two debounced watchers firing close together (the modlist and
  // mods watchers can both fire for one mod-level change) never run two absorption passes over the
  // same plugin concurrently. Every call still runs to completion — none are dropped or coalesced
  // — but each waits for whatever is already running rather than starting alongside it. The tail
  // is chained past both outcomes of `run`, so one pass throwing (there should be none —
  // `doRefresh` catches its own errors — but this is the backstop) can never wedge every refresh
  // queued after it.
  let tail: Promise<void> = Promise.resolve();
  function refresh(): Promise<void> {
    const run = tail.then(() => doRefresh(deps, state));
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    setLoaded(loadedOrigins) {
      state.loaded = loadedOrigins && new Map([...loadedOrigins].map(([name, origin]) => [fold(name), origin]));
      state.loadedNames = loadedOrigins ? [...loadedOrigins.keys()] : [];
      state.originalNameByFold = loadedOrigins && new Map(state.loadedNames.map((name) => [fold(name), name]));
    },
    refresh,
    // Nothing owned needs releasing — the FS watchers extension.ts wires this alongside are
    // disposed independently. Kept only so this still satisfies vscode.Disposable and can sit in
    // the same disposables array as everything else `wireDriftTracker` returns.
    dispose: () => { /* no-op */ },
  };
}
