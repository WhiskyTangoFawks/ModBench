import createClient from 'openapi-fetch';
import type { components, paths } from './generated/api';

export type ApiClient = ReturnType<typeof createApiClient>;

type Schemas = components['schemas'];

// Every type below is the generated wire type, named: the schema reports C# nullability and enums
// honestly, so a hand-written mirror is only a staler copy. A frontend declaration earns its place
// only as a genuine transform (LoadOrderStatus).

/** `GET /plugins`. Two held copies can share a filename, so name-keyed hand-offs read
 *  `inLoadOrder` rather than matching on the name (ADR-0044). */
export type PluginMetadata = Schemas['PluginResponse'];
export type PluginDiagnosisReport = Schemas['PluginDiagnosisReport'];

export type MasterIssue = Schemas['MasterIssue'];

/** `GET /plugins/track/status`, polled alongside the in-flight `POST /plugins/track`. Counts are
 *  of *plugins*, not records. */
export type TrackPhase = Schemas['TrackPhase'];
export type TrackStatus = Schemas['TrackProgress'];

/** Save & Compile's own result — `POST /plugins/{plugin}/compile`. A refusal is a typed,
 *  successful (HTTP 200) answer (`succeeded: false` with a `refusalReason`), never an HTTP error. */
export type CompileResult = Schemas['CompileResult'];
export type CompileDiagnostic = Schemas['CompileDiagnostic'];

/** `GET /plugins/external-changes/status`. `metaChanged` only informs the dialog's default button
 *  — trailers never act (ADR-0041); `oldVersion`/`newVersion` must be shown, not hidden. */
export type UnansweredExternalChange = Schemas['UnansweredExternalChangeResponse'];

/** Rides `PUT /load-order`'s own response: either reason can newly arise only from a compile this
 *  process drives, or from a restart, and every reconcile observes both (ADR-0026). */
export type CrashRepairReason = Schemas['CrashRepairReason'];
export type CrashRepairOffer = Schemas['CrashRepairOffer'];

/** Absorb Upstream Update / Keep as My Edit's shared result — a refusal (e.g. Keep's same-record
 *  collision) is a typed, successful answer, the same posture {@link CompileResult} uses. */
export type ExternalChangeActionResult = Schemas['ExternalChangeActionResponse'];

/** The offered rebase's three outcomes. `conflictedPaths` is the extension's cue to open each path
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

/** `GET /notifications/stream`'s one wire shape for every kind (ADR-0046 invariant 12). `kind` is
 *  a plain `string` on the schema — it is a discriminator, not a C# enum. */
export type NotificationEvent = Schemas['NotificationEvent'];

/** The `load-order-status` notification's payload, subscribed alongside the in-flight
 *  `PUT /load-order`. The wire's `state` is deliberately not carried: it duplicates
 *  `conflictsComputed`, and a second, coincidentally equal field would invite the wrong read. */
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

/** The transform a `load-order-status` notification's nested payload needs before it is this
 *  side's {@link LoadOrderStatus}: the wire's `indexedPlugins` carries each entry's origin too,
 *  and the consumer keys on filename alone. */
export function toLoadOrderStatus(wire: Schemas['LoadOrderStatus']): LoadOrderStatus {
  return {
    totalPlugins: wire.totalPlugins,
    indexedPlugins: wire.indexedPlugins.map((p) => p.name),
    conflictsComputed: wire.conflictsComputed,
    failures: wire.failures,
  };
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

/** Read off the ProblemDetails extension, never the status code: 503 alone cannot tell a busy
 *  write gate from a vanished load order, and the two want opposite responses — retry versus
 *  reload. */
export function isWriteGateTimeout(error: unknown): boolean {
  return (error as { writeGateTimeout?: boolean } | undefined)?.writeGateTimeout === true;
}

/** Deliberately not the backend's own detail, which names an implementation and a timeout: the
 *  actionable facts are that nothing was written (the gate is taken around the write) and that
 *  repeating the gesture is the way out. */
export function writeGateBusyMessage(failMsg: string): string {
  return `${failMsg} — another change is still being written. Try again in a moment.`;
}
