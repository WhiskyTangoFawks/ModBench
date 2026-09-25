import createClient from 'openapi-fetch';
import type { components, paths } from '../wire/generated/api';

export type ApiClient = ReturnType<typeof createApiClient>;

type Schemas = components['schemas'];

// Every type below is the generated wire type, named: the schema reports C# nullability and enums
// honestly, so a hand-written mirror is only a staler copy. A frontend declaration earns its place
// only as a genuine transform (LoadOrderStatus).

/** `GET /plugins`. Two held copies can share a filename, so name-keyed hand-offs read
 *  `inLoadOrder` rather than matching on the name (ADR-0013). */
export type PluginMetadata = Schemas['PluginResponse'];
export type PluginDiagnosisReport = Schemas['PluginDiagnosisReport'];

export type MasterIssue = Schemas['MasterIssue'];

/** The `track-progress` notification's payload, subscribed alongside the in-flight
 *  `POST /plugins/track`. Counts are of *plugins*, not records. */
export type TrackPhase = Schemas['TrackPhase'];
export type TrackStatus = Schemas['TrackProgress'];

/** Compile's own result — `POST /plugins/{plugin}/compile`. A refusal is a typed,
 *  successful (HTTP 200) answer (`succeeded: false` with a `refusalReason`), never an HTTP error. */
export type CompileResult = Schemas['CompileResult'];
export type CompileDiagnostic = Schemas['CompileDiagnostic'];

/** One mod's queued question. `plugins`/`trackedFiles` can each be empty; `metaChanged` only
 *  informs the dialog's default button, never acts (ADR-0007). */
export interface UnansweredExternalChange {
  origin: string;
  plugins: string[];
  trackedFiles: string[];
  metaChanged: boolean;
  oldVersion: string | null;
  newVersion: string | null;
}

/** ADR-0013: names the copy that failed — two copies of one name are two registrations. */
export type PluginLoadFailure = Schemas['PluginLoadFailure'];

/** The one list `CrashRepairReason` and `isCrashRepairReason` both derive from, since the enum
 *  left the wire with the load-order response's failures — nothing generates it for us. */
export const CRASH_REPAIR_REASONS = ['InterruptedCompile', 'MissingOrUnreadableBinary'] as const;

/** A transform of `question-open`'s own `crashRepairReason` string. */
export type CrashRepairReason = typeof CRASH_REPAIR_REASONS[number];

/** One `question-open` notification's crash-repair verdict, exploded to one offer per plugin it
 *  named — the shape the dialog presents one modal per. */
export interface CrashRepairOffer {
  plugin: string;
  origin: string;
  reason: CrashRepairReason;
}

/** Apply's result — a refusal (e.g. a same-record collision) is a typed, successful answer, the
 *  same posture {@link CompileResult} uses. */
export type ExternalChangeActionResult = Schemas['ExternalChangeActionResponse'];

/** The outcomes of `rebase edit branch`. `conflictedPaths` is the extension's cue to open each path
 *  in VS Code's native merge editor. */
export type RebaseOutcome = Schemas['RebaseOutcome'];
export type RebaseResult = Schemas['RebaseResponse'];

/** Deliberately not a boolean pair (which carries an "Added implies dirty" invariant every
 *  consumer must remember), and leaves room for a future 'Deleted' without a wire reshape. */
export type WorkingTreeState = Schemas['WorkingTreeState'];

export type RecordSummary = Schemas['RecordSummary'];

/** A flattened RecordSummary plus `recordType`, so the tree can tell a nested-expandable child
 *  from a leaf. plugin/origin are the parent's own, carried so no consumer reaches back to it. */
export type ContainerChildSummary = Schemas['ContainerChildSummary'];

// `fullName` is the CELL's own FULL, independent of `isPersistentWorldspaceCell`, because xEdit's
// GetDisplayName checks FULL first, unconditionally. `topCells` is a list because the backend
// surfaces every block-less cell it finds, though a worldspace should have only one.
export type WorldspaceSummary = Schemas['WorldspaceSummary'];
export type CellSummary = Schemas['CellSummary'];
export type PlacedSummary = Schemas['PlacedSummary'];
export type CellReferences = Schemas['CellReferences'];
export type WorldspaceSubBlock = Schemas['WorldspaceSubBlockDto'];
export type WorldspaceBlock = Schemas['WorldspaceBlockDto'];
export type WorldspaceBlocks = Schemas['WorldspaceBlocks'];

/** `GET /notifications/stream`'s one wire shape for every kind (ADR-0014 invariant 2). `kind` is
 *  a plain `string` on the schema — it is a discriminator, not a C# enum. */
export type NotificationEvent = Schemas['NotificationEvent'];

/** The two refusal states carry different scope (ADR-0009 point 5): `heldElsewhere` overrides
 *  even an already-held row, `failed` only a row not yet held. Internal to the client, not a
 *  wire type. */
export type LoadOrderRefusal = { kind: 'heldElsewhere' | 'failed'; message: string };

/** The `load-order-status` notification's payload, subscribed alongside the in-flight
 *  `PUT /load-order`. The wire's `state` survives only as `refusal.kind` and `holdsNone`. */
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
   *  the reconcile finishes (ADR-0019). */
  failures: PluginLoadFailure[];
  /** Set for the wire's `HeldElsewhere` or `Failed` state (ADR-0019) — the one place either
   *  reaches the extension, since the put's own outcome reports applied regardless. */
  refusal?: LoadOrderRefusal;
  /** The Apply this status answers for. A client waits for this to reach its own Apply's
   *  version, never for a tick a fast or no-op reconcile can settle before it subscribes. */
  version: number;
  /** The wire's `None`: no load order has arrived, or a rebuild dropped the index it filled. */
  holdsNone: boolean;
}

// A refusal state with no message is not carried as a refusal at all.
function refusalOf(wire: Schemas['LoadOrderStatus']): LoadOrderRefusal | undefined {
  if (wire.message == null) return undefined;
  if (wire.state === 'HeldElsewhere') return { kind: 'heldElsewhere', message: wire.message };
  if (wire.state === 'Failed') return { kind: 'failed', message: wire.message };
  return undefined;
}

/** The transform a `load-order-status` payload needs before it is this side's
 *  {@link LoadOrderStatus}: `indexedPlugins` carries each entry's origin too, and the
 *  consumer keys on filename alone; `state` is kept as `refusal.kind` and `holdsNone`. */
export function toLoadOrderStatus(wire: Schemas['LoadOrderStatus']): LoadOrderStatus {
  return {
    totalPlugins: wire.totalPlugins,
    indexedPlugins: wire.indexedPlugins.map((p) => p.name),
    conflictsComputed: wire.conflictsComputed,
    failures: wire.failures,
    refusal: refusalOf(wire),
    version: wire.version,
    holdsNone: wire.state === 'None',
  };
}

/** Ready, or either refusal, and for the version an Apply actually answers — a status still
 *  settling an older version, or one a no-op resend left untouched, is not this one's answer. */
export function isTerminalLoadOrderStatusFor(status: LoadOrderStatus, appliedVersion: number): boolean {
  return status.version >= appliedVersion && (status.conflictsComputed || status.refusal !== undefined);
}

export function createApiClient(port: number, fetch?: (input: Request) => Promise<Response>) {
  return createClient<paths>({ baseUrl: `http://localhost:${port}`, ...(fetch ? { fetch } : {}) });
}

/** `GET /notifications/stream` is chunked, so `parseAs: 'stream'` skips the client's JSON parse
 *  and hands back the raw `Response` — the SSE adapter reads its body itself. */
export function openNotificationStream(client: ApiClient, signal: AbortSignal): Promise<Response> {
  return client.GET('/notifications/stream', { parseAs: 'stream', signal }).then(({ response }) => response);
}

/** openapi-fetch has already drained the Response body to produce `error`, so callers must use
 *  this instead of `response.text()`, which throws "Body is unusable" on a second read. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error === undefined || error === null) return '';
  // Every backend failure is RFC 7807 ProblemDetails, whose `detail` is the sentence written for
  // the user; stringifying the whole object buries it in `{"type":…,"status":…}`.
  if (typeof error === 'object') {
    const problem = error as { detail?: unknown; title?: unknown };
    if (typeof problem.detail === 'string' && problem.detail.length > 0) return problem.detail;
    if (typeof problem.title === 'string' && problem.title.length > 0) return problem.title;
  }
  return JSON.stringify(error);
}

