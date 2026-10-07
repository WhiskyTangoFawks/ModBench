import createClient from 'openapi-fetch';
import type { components, paths } from '../wire/generated/api';

export type ApiClient = ReturnType<typeof createApiClient>;

type Schemas = components['schemas'];

// Every type below is the generated wire type, named: the schema reports C# nullability and enums
// honestly, so a hand-written mirror is only a staler copy. A frontend declaration earns its place
// only as a genuine transform (LoadOrderStatus).

/** `GET /plugins`. A name-keyed hand-off reads `inLoadOrder` rather than matching on the name,
 *  which two held plugins can share (ADR-0012). */
export type PluginMetadata = Schemas['PluginResponse'];
export type PluginDiagnosisReport = Schemas['PluginDiagnosisReport'];

/** `GET /records/{formKey}/compare`: one record as every active plugin has it, carried
 *  untransformed — the record panel's own consumer narrows `FieldMetadata.type` further. */
export type CompareResult = Schemas['CompareResult'];

/** One column of `POST /records/compare`: the copy a plugin holds, or the one `documentText` spells
 *  in its place. */
export type RecordCopy = Schemas['RecordCopy'];
export type CopyText = Schemas['CopyText'];

/** The `track-progress` notification's payload, subscribed alongside the in-flight
 *  `POST /plugins/track`. Counts are of *plugins*, not records. */
export type TrackStatus = Schemas['TrackProgress'];
export type ChangedPlugin = Schemas['ChangedPlugin'];

/** A plugin compile wrote — `POST /plugins/compile` — with the diagnostics the reference check
 *  left. */
export type CompiledPlugin = Schemas['CompiledPlugin'];
export type CompileDiagnostic = Schemas['CompileDiagnostic'];

/** ADR-0012. */
export type PluginLoadFailure = Schemas['PluginLoadFailure'];

/** Deliberately not a boolean pair (which carries an "Added implies dirty" invariant every
 *  consumer must remember), and leaves room for a future 'Deleted' without a wire reshape. */

export type RecordSummary = Schemas['RecordSummary'];

/** A flattened RecordSummary plus `recordType`, so the tree can tell a nested-expandable child
 *  from a leaf. plugin/origin are the parent's own, carried so no consumer reaches back to it. */
export type ContainerChildSummary = Schemas['ContainerChildSummary'];

// `fullName` is the CELL's own FULL, independent of `isPersistentWorldspaceCell`, because xEdit's
// GetDisplayName checks FULL first, unconditionally. `topCells` is a list because the backend
// surfaces every block-less cell it finds, though a worldspace should have only one.
export type WorldspaceSummary = Schemas['WorldspaceSummary'];
export type CellSummary = Schemas['CellSummary'];
export type ChildRecordSummary = Schemas['ChildRecordSummary'];
export type CellChildRecords = Schemas['CellChildRecords'];
export type WorldspaceSubBlock = Schemas['WorldspaceSubBlockDto'];
export type WorldspaceBlock = Schemas['WorldspaceBlockDto'];
export type WorldspaceBlocks = Schemas['WorldspaceBlocks'];

/** `GET /notifications/stream`'s one wire shape for every kind. `kind` is
 *  a plain `string` on the schema — it is a discriminator, not a C# enum. */
export type NotificationEvent = Schemas['NotificationEvent'];

/** `heldElsewhere` overrides even an already-held row, `failed` only a row not yet held
 *  (plugins.md, States, stories 4 and 6). Internal to the client, not a wire type. */
export type LoadOrderRefusal = { kind: 'heldElsewhere' | 'failed'; message: string };

/** The `load-order-status` notification's payload, subscribed alongside the in-flight
 *  `PUT /load-order`. The wire's `state` survives only as `refusal.kind` and `holdsNone`. */
export interface LoadOrderStatus {
  /** How many plugins the snapshot resolved to — the denominator for progress. Plugins that
   *  fail to open still count toward it. */
  totalPlugins: number;
  /** How many plugins the game loads: the active plugins (ADR-0012). */
  activePlugins: number;
  /** The plugins whose indexing has completed, in the order they landed. A plugin appears here
   *  only once it is wholly queryable — strictly later than "opened", which is what
   *  `GET /plugins` reports. */
  indexedPlugins: Schemas['PluginAddress'][];
  /** Whether the winner sweep has run. False means *nothing has looked yet*, which is not the
   *  same as "no conflicts" — the distinction this whole endpoint exists to make. */
  conflictsComputed: boolean;
  /** Plugins that could not be opened or indexed (ADR-0019), as they are discovered
   *  rather than once the reconcile finishes. */
  failures: PluginLoadFailure[];
  /** Set for the wire's `HeldElsewhere` or `Failed` state, the one place either
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
 *  {@link LoadOrderStatus}: `state` is kept as `refusal.kind` and `holdsNone`. */
export function toLoadOrderStatus(wire: Schemas['LoadOrderStatus']): LoadOrderStatus {
  return {
    totalPlugins: wire.totalPlugins,
    activePlugins: wire.activePlugins,
    indexedPlugins: wire.indexedPlugins,
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

