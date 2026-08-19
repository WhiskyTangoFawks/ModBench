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
  recordsDone: number;
  recordsTotal: number;
}

export interface RecordSummary {
  formKey: string;
  plugin: string;
  loadOrderIndex: number;
  isWinner: boolean;
  editorId: string | null;
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
  topCell: CellSummary | null;
}

export function createApiClient(port: number) {
  return createClient<paths>({ baseUrl: `http://localhost:${port}` });
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
