import createClient from 'openapi-fetch';
import type { components, paths } from './generated/api';

export type ApiClient = ReturnType<typeof createApiClient>;

type Schemas = components['schemas'];

// Every type below is the generated wire type, named. The OpenAPI schema now reports C#
// nullability and enum-string-ness honestly (#627), so a hand-written mirror would only be a
// second, staler copy of the same shape — the mapper layer these aliases replaced existed purely
// to re-assert facts the schema had dropped. A frontend type earns its own declaration only when
// it is a genuine *transform* of the wire (see LoadOrderStatus below), never to restate it.

/** `GET /plugins`. ADR-0044: `loadOrderIndex` is the name's plugins.txt slot past the backend's
 *  forced masters, and is the one honestly-nullable member — absent when no line names this copy.
 *  `enabled`/`winning` are the registration facts as Mod Management stated them; `participates`
 *  (competes for winner) and `inLoadOrder` (is the copy plugins.txt names) are the backend's two
 *  derivations from them. Two held copies can share a filename, so the name-keyed hand-offs in
 *  extension.ts read `inLoadOrder`. ADR-0036: `origin` is the mod folder (or reserved PluginOrigin
 *  value) this copy was resolved from. ADR-0037: `masterIssues` is this plugin's own unresolvable
 *  declared masters, never a transitive fact about a master's own masters. ADR-0035 amending
 *  ADR-0018: `hasMatchingRecords` is true with no active record filter, or when this plugin owns at
 *  least one matching record — PluginsTreeComposite omits a `false` row entirely rather than only
 *  suppressing its chevron. ADR-0041: `isTracked` is whether the mod folder holds a `.git`. */
export type PluginMetadata = Schemas['PluginResponse'];
export type PluginDiagnosisReport = Schemas['PluginDiagnosisReport'];

export type MasterIssue = Schemas['MasterIssue'];

/** What `TrackService` can say about a Track in flight — `GET /plugins/track/status`, polled
 *  alongside the in-flight `POST /plugins/track`, the same idiom `GET /load-order/status`
 *  established. `'Idle'` means nothing is running. Counts are of *plugins*, not records. */
export type TrackPhase = Schemas['TrackPhase'];
export type TrackStatus = Schemas['TrackProgress'];

/** Save & Compile's own result — `POST /plugins/{plugin}/compile`. A refusal is a typed,
 *  successful (HTTP 200) answer (`succeeded: false` with a `refusalReason`), never an HTTP error. */
export type CompileResult = Schemas['CompileResult'];
export type CompileDiagnostic = Schemas['CompileDiagnostic'];

/** One queued external-change question — `GET /plugins/external-changes/status`. `metaChanged` is
 *  the dialog's default-button tell (trailers inform the default, never act — ADR-0041 amendment);
 *  `oldVersion`/`newVersion` are the evidence the pinned UX contract says must be shown when it
 *  fired, not hidden. */
export type UnansweredExternalChange = Schemas['UnansweredExternalChangeResponse'];

/** The two ways a tracked plugin's binary can turn up stale against what Modbench last knew — an
 *  interrupted compile (an unfinished journal marker) or a binary that could not be read at all.
 *  Rides `PUT /load-order`'s own response the way `failures` already does (ADR-0026): the only ways
 *  either can newly arise are a compile this process drives, or a restart, and every reconcile
 *  observes both. */
export type CrashRepairReason = Schemas['CrashRepairReason'];
export type CrashRepairOffer = Schemas['CrashRepairOffer'];

/** Absorb Upstream Update / Keep as My Edit's shared result — a refusal (e.g. Keep's same-record
 *  collision) is a typed, successful answer, the same posture {@link CompileResult} uses. */
export type ExternalChangeActionResult = Schemas['ExternalChangeActionResponse'];

/** The offered rebase's three outcomes. `conflictedPaths` is the extension's cue to open each path
 *  in VS Code's native merge editor. */
export type RebaseOutcome = Schemas['RebaseOutcome'];
export type RebaseResult = Schemas['RebaseResponse'];

/** The Plugins tree's own working-tree fact for a listed record — 'None' for the overwhelming
 *  majority. Deliberately not a boolean pair (an "Added implies dirty" invariant every consumer
 *  would have to remember), and leaves room for a future 'Deleted' without a wire reshape. */
export type WorkingTreeState = Schemas['WorkingTreeState'];

export type RecordSummary = Schemas['RecordSummary'];

/** A container record's own children (a Quest's dialog topics/branches/scenes, a Dialog Topic's
 *  responses) — a flattened RecordSummary plus `recordType`, so the tree can tell a
 *  nested-expandable child (a DIAL under a Quest) from a leaf. plugin/origin are always the
 *  parent's own, carried rather than assumed so a consumer never reaches back to the parent node. */
export type ContainerChildSummary = Schemas['ContainerChildSummary'];

// Worldspace / cell / placed-object tree (per-plugin). `CellSummary.isPersistentWorldspaceCell` is
// xEdit's "<Persistent Worldspace Cell>", read directly rather than inferred from which field of
// WorldspaceBlocks a cell arrived in; `fullName` is the CELL's own FULL name, independent of it,
// because xEdit's TwbMainRecord.GetDisplayName checks FULL first, unconditionally.
// `WorldspaceBlocks.topCells` is a list, not a single nullable cell — a worldspace is only
// supposed to have one block-less cell (its TopCell), but the backend surfaces every one it finds.
export type WorldspaceSummary = Schemas['WorldspaceSummary'];
export type CellSummary = Schemas['CellSummary'];
export type PlacedSummary = Schemas['PlacedSummary'];
export type CellReferences = Schemas['CellReferences'];
export type WorldspaceSubBlock = Schemas['WorldspaceSubBlockDto'];
export type WorldspaceBlock = Schemas['WorldspaceBlockDto'];
export type WorldspaceBlocks = Schemas['WorldspaceBlocks'];

/** ADR-0035: what the load order can say about itself *while a reconcile is still running* —
 *  `GET /load-order/status`, polled alongside the in-flight `PUT /load-order`.
 *
 *  The one hand-written type here, because it is a genuine transform rather than a restatement.
 *  Two things differ from the wire and both are deliberate:
 *
 *  `indexedPlugins` is flattened to filenames. It is consumed by
 *  `PluginsTreeComposite.setLoadOrder`, which keys on the plugin filename (the boundary object
 *  CONTEXT-MAP.md names); the wire also carries each entry's origin, which nothing on this path
 *  needs, so it is dropped here rather than carried unused.
 *
 *  The wire's `state` is deliberately *not* carried. It is derived from `conflictsComputed` today
 *  and duplicates it; anything deciding whether to render conflict information must read
 *  `conflictsComputed` (LoadOrderStatus.cs makes this the field's whole reason for existing), and
 *  offering a second, coincidentally-equal field would invite exactly the wrong read. */
export interface LoadOrderStatus {
  /** How many plugin copies the snapshot resolved to — the denominator for progress. Copies that
   *  fail to open still count toward it. */
  totalPlugins: number;
  /** Filenames of the plugins whose indexing has completed, in the order they landed. A plugin
   *  appears here only once it is wholly queryable — strictly later than "opened", which is what
   *  `GET /plugins` reports. */
  indexedPlugins: string[];
  /** Whether the winner sweep has run. False means *nothing has looked yet*, which is not the
   *  same as "no conflicts" — the distinction this whole endpoint exists to make. */
  conflictsComputed: boolean;
  /** Plugins that could not be opened or indexed, as they are discovered — not held back until
   *  the reconcile finishes (ADR-0026). */
  failures: Schemas['PluginLoadFailure'][];
}

export function createApiClient(port: number, fetch?: (input: Request) => Promise<Response>) {
  return createClient<paths>({ baseUrl: `http://localhost:${port}`, ...(fetch ? { fetch } : {}) });
}

/** Stringify openapi-fetch's `error` value from a non-ok response. openapi-fetch
 *  already reads the body to produce this (JSON-parsed where possible) — the
 *  underlying Response's body stream is drained, so callers must use this instead
 *  of `response.text()`, which throws "Body is unusable" on a second read. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error === undefined || error === null) return '';
  // Every backend failure is RFC 7807 ProblemDetails (Results.Problem), whose `detail` is the
  // sentence written for the user — "this instance's index is open in another Modbench window",
  // "Game directory not found: …". A toast that stringifies the whole object buries that
  // sentence in `{"type":…,"status":…}`; the problem's own text is the message.
  if (typeof error === 'object') {
    const problem = error as { detail?: unknown; title?: unknown };
    if (typeof problem.detail === 'string' && problem.detail.length > 0) return problem.detail;
    if (typeof problem.title === 'string' && problem.title.length > 0) return problem.title;
  }
  return JSON.stringify(error);
}

/** #673: whether this failure is the process-wide write gate timing out on a write already in
 *  flight (`WriteEndpointMapping.WriteGateBusy`). Read off the ProblemDetails extension, never off
 *  the status code or the prose (ADR-0026): the status says what *kind* of problem this is, and
 *  503 alone cannot tell this apart from the load order having gone away (`NoLoadOrder`) — while
 *  the two want opposite responses, retry versus reload. The extension is a
 *  `Dictionary<string, object?>` with no schema to mirror, so reading it is a cast by necessity,
 *  exactly as `EditingController`'s own `eslContradictionMessage` reads `#290`'s. */
export function isWriteGateTimeout(error: unknown): boolean {
  return (error as { writeGateTimeout?: boolean } | undefined)?.writeGateTimeout === true;
}

/** What the user is told when the gate timed out — the *one* place that sentence exists, because
 *  all six gate-wrapped write endpoints reach the user through two different shapes (five through
 *  `EditingController.mutate`, the field edit through `PluginRepository.editRecordField`) and a
 *  reworded busy message must stay one string to change.
 *
 *  Deliberately not the backend's own detail ("Another write to the record index is still in
 *  progress after 5s."), which names an implementation and a timeout: the only actionable facts
 *  are that nothing was written (the gate is taken *around* the write, so there is no half-applied
 *  state) and that repeating the gesture is the way out. `failMsg` leads, so the message keeps
 *  saying which gesture this was. */
export function writeGateBusyMessage(failMsg: string): string {
  return `${failMsg} — another change is still being written. Try again in a moment.`;
}
