import type { components } from './generated/api';
import type {
  ApiClient, PluginMetadata, MasterIssue, RecordSummary, SessionStatus,
  WorldspaceSummary, CellSummary, CellReferences, PlacedSummary, WorldspaceBlocks,
} from './ApiClient';
import { errorText } from './ApiClient';

type PluginResponse = components['schemas']['PluginResponse'];
type GeneratedMasterIssue = components['schemas']['MasterIssue'];
type GeneratedRecordSummary = components['schemas']['RecordSummary'];
type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];

function toMasterIssue(i: GeneratedMasterIssue): MasterIssue {
  return { masterName: i.masterName ?? '', kind: i.kind ?? 'DirectlyMissing' };
}

// #275 / ADR-0036: the backend always populates PluginResponse.Origin with a real, non-empty
// value — the generated type still shows `origin?: string | null` only because this backend's
// OpenAPI schema generator isn't NRT-aware for any property (#297), not because origin is ever
// actually optional on the wire. Fabricating a fallback (the reserved Data-directory value some
// previous code used) would silently mislabel a real backend regression as "this plugin came
// from the Data directory" — exactly the silent-wrong-state class of bug this epic exists to
// stop (ADR-0026). Fail loudly instead.
function requireOrigin(r: PluginResponse): string {
  if (!r.origin) throw new Error(`mEdit: backend returned a plugin without an origin (${r.name ?? '<unknown>'})`);
  return r.origin;
}

function toPluginMetadata(r: PluginResponse): PluginMetadata {
  return {
    name: r.name ?? '',
    path: r.path ?? '',
    loadOrderIndex: r.loadOrderIndex ?? 0,
    isLight: r.isLight ?? false,
    isMaster: r.isMaster ?? false,
    masters: r.masters ?? [],
    recordCount: r.recordCount ?? 0,
    isImmutable: r.isImmutable ?? false,
    origin: requireOrigin(r),
    masterIssues: (r.masterIssues ?? []).map(toMasterIssue),
  };
}

function toRecordSummary(r: GeneratedRecordSummary): RecordSummary {
  return {
    formKey: r.formKey ?? '',
    plugin: r.plugin ?? '',
    loadOrderIndex: r.loadOrderIndex ?? 0,
    isWinner: r.isWinner ?? false,
    editorId: r.editorId ?? null,
  };
}

function toRecordTypeCount(r: PluginRecordTypeCount): { type: string; count: number; displayName: string } {
  const type = r.type ?? '';
  return { type, count: r.count ?? 0, displayName: r.displayName ?? type };
}

type GenWorldspace = components['schemas']['WorldspaceSummary'];
type GenCell = components['schemas']['CellSummary'];
type GenPlaced = components['schemas']['PlacedSummary'];

function toCellSummary(c: GenCell): CellSummary {
  return {
    formKey: c.formKey ?? '',
    editorId: c.editorId ?? null,
    cellX: c.cellX ?? null,
    cellY: c.cellY ?? null,
  };
}

function toPlacedSummary(p: GenPlaced): PlacedSummary {
  return {
    formKey: p.formKey ?? '',
    editorId: p.editorId ?? null,
    baseFormKey: p.baseFormKey ?? null,
    recordType: p.recordType ?? '',
  };
}

export interface RecordPage {
  items: RecordSummary[];
  total: number;
}

export interface CellPage {
  items: CellSummary[];
  total: number;
}

export interface PluginRepository {
  getPlugins(): Promise<PluginMetadata[]>;
  // #307 / ADR-0035: the load's own progress, polled alongside the in-flight load POST. Separate
  // from getPlugins() rather than folded into it: this one answers while the session is still
  // incomplete, and it is the only read that can distinguish "not looked yet" from "no conflict".
  getSessionStatus(): Promise<SessionStatus>;
  // origin (#34 / ADR-0036): which copy of `plugin` to read, when the session holds two files of
  // one filename. Optional — an ordinary load-order row has no origin to give, and the backend
  // resolves that case from the load order, where a filename is unambiguous.
  getRecordTypes(plugin: string, origin?: string): Promise<{ type: string; count: number; displayName: string }[]>;
  getRecords(plugin: string, type: string, offset: number, limit: number, origin?: string): Promise<RecordPage>;
  // Issue #210: the FormKey picker's own search — free-text `query` matched against EditorID or
  // (as of #210) a FormKey-shaped string, scoped to `validTypes` only when there's exactly one
  // (an unscoped/multi-type field searches across every record type, same as the deleted
  // webview-side RecordSessionClient.searchRecords this replaces). Capped at 20 results, matching
  // the old picker's page size.
  searchRecords(query: string, validTypes: string[]): Promise<RecordPage>;
  // Issue #211: the condition-function picker's catalog — every function name Mutagen resolves
  // for the loaded session's game, backing the extension-host QuickPick. Degrades to [] on a
  // failed fetch (mirrors setFilter/clearFilter's catch-and-log-no-throw below, not the
  // ensureOk-then-throw convention most reads here use) — a failed catalogue fetch must never
  // surface as a raw error, same as the deleted webview-side RecordSessionClient
  // .conditionFunctions() it replaces.
  getConditionFunctions(): Promise<string[]>;
  setFilter(sql: string): Promise<string | null>; // returns error message or null on success
  clearFilter(): Promise<void>;
  getActiveFilter(): Promise<string | null>;

  // Phase 16: per-plugin worldspace tree. origin (#305 / ADR-0036): same optional shape as
  // getRecordTypes/getRecords above — a row that stands for a specific copy states it.
  getWorldspaces(plugin: string, origin?: string): Promise<WorldspaceSummary[]>;
  getWorldspaceBlocks(plugin: string, worldspaceFormKey: string, origin?: string): Promise<WorldspaceBlocks>;
  getCellReferences(plugin: string, cellFormKey: string, origin?: string): Promise<CellReferences>;
  getInteriorCells(plugin: string, offset: number, limit: number, origin?: string): Promise<CellPage>;
}

export class ApiPluginRepository implements PluginRepository {
  private readonly log: (msg: string) => void;

  constructor(private readonly client: ApiClient, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  // Don't swallow read failures into []/empty: a 503 "No session loaded", a 500,
  // or a network error must reach the tree so it renders an ErrorNode rather than
  // a silent empty list indistinguishable from genuinely empty data (issues #75,
  // #129, ADR-0026). A 200 with an empty/absent body is a legitimate empty result.
  // Genuine network-level throws propagate as-is. Mirrors the getPlugins convention.
  private ensureOk(what: string, response: Response, error?: unknown): void {
    if (response.ok) return;
    const text = errorText(error);
    const detail = text ? `: ${text}` : '';
    const msg = `${what} failed (${response.status})${detail}`;
    this.log(`[PluginRepository] ${msg}`);
    throw new Error(msg);
  }

  async getPlugins(): Promise<PluginMetadata[]> {
    const { data, error, response } = await this.client.GET('/plugins', {});
    this.ensureOk('GET /plugins', response, error);
    return (data ?? []).map(toPluginMetadata);
  }

  // #307: the endpoint answers 200 in every state including "no session" (SessionEndpoints.cs),
  // so a non-ok is a genuine fault and gets the same ensureOk treatment as every other read here.
  // Degrading it to an empty status would be indistinguishable from a load making no progress.
  async getSessionStatus(): Promise<SessionStatus> {
    const { data, error, response } = await this.client.GET('/session/status', {});
    this.ensureOk('GET /session/status', response, error);
    return {
      totalPlugins: data?.totalPlugins ?? 0,
      // The wire carries each entry's origin too; the consumer keys on filename alone (see
      // SessionStatus in ApiClient.ts), so it is dropped here rather than carried unused.
      indexedPlugins: (data?.indexedPlugins ?? []).map((p) => p.name ?? ''),
      conflictsComputed: data?.conflictsComputed ?? false,
      failures: (data?.failures ?? []).map((f) => ({ name: f.name ?? '', reason: f.reason ?? 'Unknown error' })),
    };
  }

  async getRecordTypes(plugin: string, origin?: string): Promise<{ type: string; count: number; displayName: string }[]> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/record-types', {
      params: { path: { plugin }, query: origin === undefined ? {} : { origin } },
    });
    this.ensureOk(`getRecordTypes(${plugin})`, response, error);
    return (data ?? []).map(toRecordTypeCount);
  }

  async getRecords(plugin: string, type: string, offset: number, limit: number, origin?: string): Promise<RecordPage> {
    const { data, error, response } = await this.client.GET('/records', {
      params: { query: { plugin, type, offset, limit, ...(origin === undefined ? {} : { origin }) } },
    });
    this.ensureOk(`getRecords(${plugin}, ${type})`, response, error);
    return {
      items: (data?.items ?? []).map(toRecordSummary),
      total: data?.total ?? 0,
    };
  }

  async searchRecords(query: string, validTypes: string[]): Promise<RecordPage> {
    const { data, error, response } = await this.client.GET('/records', {
      params: {
        query: {
          search: query,
          ...(validTypes.length === 1 ? { type: validTypes[0] } : {}),
          limit: 20,
        },
      },
    });
    this.ensureOk(`searchRecords(${query})`, response, error);
    return {
      items: (data?.items ?? []).map(toRecordSummary),
      total: data?.total ?? 0,
    };
  }

  async getConditionFunctions(): Promise<string[]> {
    try {
      const { data, response } = await this.client.GET('/condition-functions', {});
      if (!response.ok) {
        this.log(`[PluginRepository] getConditionFunctions failed (${response.status})`);
        return [];
      }
      return data ?? [];
    } catch (e) {
      this.log(`[PluginRepository] getConditionFunctions failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  async setFilter(sql: string): Promise<string | null> {
    try {
      const { error, response } = await this.client.POST('/session/filter', { body: { sql } });
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[PluginRepository] setFilter failed (${response.status}): ${text}`);
        return text;
      }
      return null;
    } catch (e) {
      this.log(`[PluginRepository] setFilter failed: ${e instanceof Error ? e.message : String(e)}`);
      return e instanceof Error ? e.message : String(e);
    }
  }

  async clearFilter(): Promise<void> {
    try {
      const { error, response } = await this.client.DELETE('/session/filter', {});
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[PluginRepository] clearFilter failed (${response.status}): ${text}`);
      }
    } catch (e) {
      this.log(`[PluginRepository] clearFilter failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async getActiveFilter(): Promise<string | null> {
    const { data, error, response } = await this.client.GET('/session/filter', {});
    this.ensureOk('getActiveFilter', response, error);
    return data?.sql ?? null;
  }

  async getWorldspaces(plugin: string, origin?: string): Promise<WorldspaceSummary[]> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/worldspaces', {
      params: { path: { plugin }, query: origin === undefined ? {} : { origin } },
    });
    this.ensureOk(`getWorldspaces(${plugin})`, response, error);
    return (data ?? []).map((w: GenWorldspace) => ({
      formKey: w.formKey ?? '',
      editorId: w.editorId ?? null,
    }));
  }

  async getWorldspaceBlocks(plugin: string, worldspaceFormKey: string, origin?: string): Promise<WorldspaceBlocks> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/worldspaces/{formKey}/blocks', {
      params: { path: { plugin, formKey: worldspaceFormKey }, query: origin === undefined ? {} : { origin } },
    });
    this.ensureOk(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, response, error);
    return {
      topCell: data?.topCell ? toCellSummary(data.topCell) : null,
      blocks: (data?.blocks ?? []).map(b => ({
        x: b.x ?? 0,
        y: b.y ?? 0,
        subBlocks: (b.subBlocks ?? []).map(s => ({
          x: s.x ?? 0,
          y: s.y ?? 0,
          cells: (s.cells ?? []).map(toCellSummary),
        })),
      })),
    };
  }

  async getCellReferences(plugin: string, cellFormKey: string, origin?: string): Promise<CellReferences> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/cells/{formKey}/references', {
      params: { path: { plugin, formKey: cellFormKey }, query: origin === undefined ? {} : { origin } },
    });
    this.ensureOk(`getCellReferences(${plugin}, ${cellFormKey})`, response, error);
    return {
      persistent: (data?.persistent ?? []).map(toPlacedSummary),
      temporary: (data?.temporary ?? []).map(toPlacedSummary),
    };
  }

  async getInteriorCells(plugin: string, offset: number, limit: number, origin?: string): Promise<CellPage> {
    const { data, error, response } = await this.client.GET('/plugins/{plugin}/interior-cells', {
      params: { path: { plugin }, query: { offset, limit, ...(origin === undefined ? {} : { origin }) } },
    });
    this.ensureOk(`getInteriorCells(${plugin})`, response, error);
    return {
      items: (data?.items ?? []).map(toCellSummary),
      total: data?.total ?? 0,
    };
  }
}
