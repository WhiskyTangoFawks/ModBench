import type { components } from './generated/api';
import type {
  ApiClient, PluginMetadata, RecordSummary,
  WorldspaceSummary, CellSummary, CellReferences, PlacedSummary, WorldspaceBlocks,
} from './ApiClient';

type PluginResponse = components['schemas']['PluginResponse'];
type GeneratedRecordSummary = components['schemas']['RecordSummary'];
type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];

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
  getRecordTypes(plugin: string): Promise<{ type: string; count: number; displayName: string }[]>;
  getRecords(plugin: string, type: string, offset: number, limit: number): Promise<RecordPage>;
  setFilter(sql: string): Promise<string | null>; // returns error message or null on success
  clearFilter(): Promise<void>;
  getActiveFilter(): Promise<string | null>;

  // Phase 16: per-plugin worldspace tree.
  getWorldspaces(plugin: string): Promise<WorldspaceSummary[]>;
  getWorldspaceBlocks(plugin: string, worldspaceFormKey: string): Promise<WorldspaceBlocks>;
  getCellReferences(plugin: string, cellFormKey: string): Promise<CellReferences>;
  getInteriorCells(plugin: string, offset: number, limit: number): Promise<CellPage>;
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
  private async ensureOk(what: string, response: Response): Promise<void> {
    if (response.ok) return;
    const text = await response.text().catch(() => ''); // best-effort detail; a body-read failure is non-fatal — the status carries the error
    const detail = text ? `: ${text}` : '';
    const msg = `${what} failed (${response.status})${detail}`;
    this.log(`[PluginRepository] ${msg}`);
    throw new Error(msg);
  }

  async getPlugins(): Promise<PluginMetadata[]> {
    const { data, response } = await this.client.GET('/plugins', {});
    await this.ensureOk('GET /plugins', response);
    return (data ?? []).map(toPluginMetadata);
  }

  async getRecordTypes(plugin: string): Promise<{ type: string; count: number; displayName: string }[]> {
    const { data, response } = await this.client.GET('/plugins/{plugin}/record-types', {
      params: { path: { plugin } },
    });
    await this.ensureOk(`getRecordTypes(${plugin})`, response);
    return (data ?? []).map(toRecordTypeCount);
  }

  async getRecords(plugin: string, type: string, offset: number, limit: number): Promise<RecordPage> {
    const { data, response } = await this.client.GET('/records', {
      params: { query: { plugin, type, offset, limit } },
    });
    await this.ensureOk(`getRecords(${plugin}, ${type})`, response);
    return {
      items: (data?.items ?? []).map(toRecordSummary),
      total: data?.total ?? 0,
    };
  }

  async setFilter(sql: string): Promise<string | null> {
    try {
      const { response } = await this.client.POST('/session/filter', { body: { sql } });
      if (!response.ok) {
        const text = await response.text();
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
      const { response } = await this.client.DELETE('/session/filter', {});
      if (!response.ok) {
        const text = await response.text();
        this.log(`[PluginRepository] clearFilter failed (${response.status}): ${text}`);
      }
    } catch (e) {
      this.log(`[PluginRepository] clearFilter failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async getActiveFilter(): Promise<string | null> {
    const { data, response } = await this.client.GET('/session/filter', {});
    await this.ensureOk('getActiveFilter', response);
    return data?.sql ?? null;
  }

  async getWorldspaces(plugin: string): Promise<WorldspaceSummary[]> {
    const { data, response } = await this.client.GET('/plugins/{plugin}/worldspaces', {
      params: { path: { plugin } },
    });
    await this.ensureOk(`getWorldspaces(${plugin})`, response);
    return (data ?? []).map((w: GenWorldspace) => ({
      formKey: w.formKey ?? '',
      editorId: w.editorId ?? null,
    }));
  }

  async getWorldspaceBlocks(plugin: string, worldspaceFormKey: string): Promise<WorldspaceBlocks> {
    const { data, response } = await this.client.GET('/plugins/{plugin}/worldspaces/{formKey}/blocks', {
      params: { path: { plugin, formKey: worldspaceFormKey } },
    });
    await this.ensureOk(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, response);
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

  async getCellReferences(plugin: string, cellFormKey: string): Promise<CellReferences> {
    const { data, response } = await this.client.GET('/plugins/{plugin}/cells/{formKey}/references', {
      params: { path: { plugin, formKey: cellFormKey } },
    });
    await this.ensureOk(`getCellReferences(${plugin}, ${cellFormKey})`, response);
    return {
      persistent: (data?.persistent ?? []).map(toPlacedSummary),
      temporary: (data?.temporary ?? []).map(toPlacedSummary),
    };
  }

  async getInteriorCells(plugin: string, offset: number, limit: number): Promise<CellPage> {
    const { data, response } = await this.client.GET('/plugins/{plugin}/interior-cells', {
      params: { path: { plugin }, query: { offset, limit } },
    });
    await this.ensureOk(`getInteriorCells(${plugin})`, response);
    return {
      items: (data?.items ?? []).map(toCellSummary),
      total: data?.total ?? 0,
    };
  }
}
