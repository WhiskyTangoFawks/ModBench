import createClient from 'openapi-fetch';
import type { paths } from './generated/api';

export type ApiClient = ReturnType<typeof createApiClient>;

export interface PluginMetadata {
  name: string;
  path: string;
  loadOrderIndex: number;
  isLight: boolean;
  isMaster: boolean;
  masters: string[];
  recordCount: number;
  isImmutable: boolean;
  // #275 / ADR-0036: the mod folder (or reserved PluginOrigin value) this plugin was resolved
  // from — on the wire since #269 (PluginResponse.Origin) but dropped here until now.
  origin: string;
  // #277 / ADR-0037: this plugin's own declared masters that don't resolve in the session —
  // never a transitive fact about a master's own masters. Empty for a plugin with none.
  masterIssues: MasterIssue[];
  // #278 / ADR-0035 amending ADR-0018: true with no active record filter, or when this plugin
  // owns at least one record the filter matches — the fact PluginsTreeComposite's chevron reads,
  // since GetPlugins() itself never drops a plugin for having none.
  hasMatchingRecords: boolean;
}

export interface MasterIssue {
  masterName: string;
  kind: 'DirectlyMissing' | 'Unloadable';
}

/** #307 / ADR-0035: what the session can say about itself *while it is still loading* —
 *  `GET /session/status`, polled alongside the in-flight load POST.
 *
 *  `indexedPlugins` is deliberately flattened to filenames: it is consumed by
 *  `PluginsTreeComposite.setSession`, which keys on the plugin filename (the boundary object
 *  CONTEXT-MAP.md names). The wire also carries each entry's origin, which nothing on this path
 *  needs yet — mapped away here rather than carried unused.
 *
 *  The wire's `state` is deliberately *not* mapped. It is derived from `conflictsComputed` today
 *  and duplicates it; anything deciding whether to render conflict information must read
 *  `conflictsComputed` (SessionStatus.cs makes this the field's whole reason for existing), and
 *  offering a second, coincidentally-equal field would invite exactly the wrong read. */
export interface SessionStatus {
  /** How many plugins this load set out to open — the denominator for progress. Plugins that
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
   *  the load finishes (ADR-0026). */
  failures: { name: string; reason: string }[];
}

/** #414 review F2: what `TrackService` can say about a Track in flight right now —
 *  `GET /plugins/track/status`, polled alongside the in-flight `POST /plugins/track`, the same
 *  idiom `SessionStatus`/`GET /session/status` above already established. `'Idle'` means nothing
 *  is running (the poll's own rest state, and what the endpoint answers before any Track and
 *  again once one finishes). */
export type TrackPhase = 'Idle' | 'Parsing' | 'Serializing' | 'Committing';

export interface TrackStatus {
  phase: TrackPhase;
  /** #451 review: plugin counts, not record counts, since Track's own #451 slice A rewrite — renamed
   *  from `recordsDone` so the wire contract can't lie about its own granularity again. */
  pluginsDone: number;
  pluginsTotal: number;
}

/** #416: Save & Compile's own result — `POST /plugins/{plugin}/compile`. A refusal is a typed,
 *  successful (HTTP 200) answer (`succeeded: false, refusalReason: string`), never an HTTP error —
 *  the pinned contract's "refusal is a typed result, not an exception" carried through the wire. */
export interface CompileResult {
  succeeded: boolean;
  refusalReason: string | null;
  diagnostics: CompileDiagnostic[];
  masters: string[];
}

export interface CompileDiagnostic {
  formKey: string;
  sourceRelativePath: string;
  message: string;
}

/** #417: one queued external-change question — `GET /plugins/external-changes/status`, polled the
 *  same way `TrackStatus`/`SessionStatus` are. `metaChanged` is the dialog's default-button tell
 *  (trailers inform the default, never act — ADR-0041 amendment); `oldVersion`/`newVersion` are the
 *  evidence the pinned UX contract says must be shown when the tell fired, not hidden. */
export interface PendingExternalChange {
  plugin: string;
  origin: string;
  metaChanged: boolean;
  oldVersion: string | null;
  newVersion: string | null;
}

/** #381: the two ways a tracked plugin's binary can turn up stale relative to what Modbench itself
 *  last knows — an interrupted compile (a pending journal marker) or a binary that could not be
 *  read at all. Mirrors the backend's CrashRepairReason enum name exactly (no re-wording on the
 *  wire boundary, same posture WorkingTreeState above already established). */
export type CrashRepairReason = 'InterruptedCompile' | 'MissingOrUnreadableBinary';

/** #381: one plugin's crash-repair offer, riding `POST /session/load[-explicit]`'s own response
 *  the same way `failures` already does (ADR-0026) — there is no separate poller or endpoint for
 *  this: the only way either reason can newly arise is a compile this same process drives, or a
 *  process restart, and a session load already observes both. */
export interface CrashRepairOffer {
  plugin: string;
  origin: string;
  reason: CrashRepairReason;
}

/** #417: Absorb Upstream Update / Keep as My Edit's shared result shape — a refusal (e.g. Keep's
 *  same-record collision) is a typed, successful (HTTP 200) answer, the same posture
 *  {@link CompileResult} already established. */
export interface ExternalChangeActionResult {
  succeeded: boolean;
  refusalReason: string | null;
}

/** #417: the offered rebase's three outcomes. `conflictedPaths` is the extension's cue to open
 *  each path in VS Code's native merge editor. */
export type RebaseOutcome = 'Clean' | 'Refused' | 'Conflicted';

export interface RebaseResult {
  outcome: RebaseOutcome;
  refusalReason: string | null;
  conflictedPaths: string[];
}

// #428: the Plugins tree's own working-tree fact for a listed record — 'None' for the
// overwhelming majority. Mirrors the backend's WorkingTreeState enum name exactly (no
// re-wording on the wire boundary). Deliberately not a boolean pair (an "Added implies dirty"
// invariant every consumer would have to remember) and leaves room for a future 'Deleted'
// value without a wire reshape (#428 orchestrator ruling; Deleted itself is out of this
// ticket's scope — see RecordDecorationProvider's own doc comment for why).
export type WorkingTreeState = 'None' | 'Modified' | 'Added';

export interface RecordSummary {
  formKey: string;
  plugin: string;
  loadOrderIndex: number;
  isWinner: boolean;
  editorId: string | null;
  workingTreeState: WorkingTreeState;
}

export interface PluginRecordTypeCount {
  type: string;
  count: number;
}

// Phase 16: worldspace / cell / placed-object tree (per-plugin).
export interface WorldspaceSummary {
  formKey: string;
  editorId: string | null;
}

export interface CellSummary {
  formKey: string;
  editorId: string | null;
  cellX: number | null;
  cellY: number | null;
  // #251: xEdit's "<Persistent Worldspace Cell>" — the tree provider's label logic reads this
  // instead of inferring it from which field of WorldspaceBlocks a cell arrived in. Required, like
  // its siblings above: the backend always emits it (toCellSummary normalizes the generated
  // schema's own optional field to a concrete boolean at the repository boundary).
  isPersistentWorldspaceCell: boolean;
  // #497: the CELL record's own FULL name, independent of isPersistentWorldspaceCell — xEdit's
  // TwbMainRecord.GetDisplayName checks FULL name first, unconditionally, before even the
  // persistent-cell placeholder, so the tree provider needs both facts separately rather than one
  // pre-resolved label. null when the cell has no FULL name set.
  fullName: string | null;
}

export interface PlacedSummary {
  formKey: string;
  editorId: string | null;
  baseFormKey: string | null;
  recordType: string;
}

export interface CellReferences {
  persistent: PlacedSummary[];
  temporary: PlacedSummary[];
}

export interface WorldspaceSubBlock {
  x: number;
  y: number;
  cells: CellSummary[];
}

export interface WorldspaceBlock {
  x: number;
  y: number;
  subBlocks: WorldspaceSubBlock[];
}

export interface WorldspaceBlocks {
  blocks: WorldspaceBlock[];
  // #251: a list, not a single nullable cell — a worldspace is only ever supposed to have one
  // block-less cell row (its TopCell), but the backend surfaces every one it finds rather than
  // discarding anything past the first.
  topCells: CellSummary[];
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
  return JSON.stringify(error);
}
