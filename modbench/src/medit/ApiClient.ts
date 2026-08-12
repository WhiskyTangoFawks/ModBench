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
