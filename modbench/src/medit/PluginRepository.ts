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

function toRecordTypeCount(r: PluginRecordTypeCount): { type: string; count: number } {
  return { type: r.type ?? '', count: r.count ?? 0 };
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
  getRecordTypes(plugin: string): Promise<{ type: string; count: number }[]>;
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

  async getPlugins(): Promise<PluginMetadata[]> {
    try {
      const { data } = await this.client.GET('/plugins', {});
      const raw = data ?? [];
      return raw.map(toPluginMetadata);
    } catch (e) {
      this.log(`[PluginRepository] getPlugins failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  async getRecordTypes(plugin: string): Promise<{ type: string; count: number }[]> {
    try {
      const { data } = await this.client.GET('/plugins/{plugin}/record-types', {
        params: { path: { plugin } },
      });
      const raw = data ?? [];
      return raw.map(toRecordTypeCount);
    } catch (e) {
      this.log(`[PluginRepository] getRecordTypes(${plugin}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  async getRecords(plugin: string, type: string, offset: number, limit: number): Promise<RecordPage> {
    try {
      const { data } = await this.client.GET('/records', {
        params: { query: { plugin, type, offset, limit } },
      });
      const raw = data;
      return {
        items: (raw?.items ?? []).map(toRecordSummary),
        total: raw?.total ?? 0,
      };
    } catch (e) {
      this.log(`[PluginRepository] getRecords(${plugin}, ${type}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return { items: [], total: 0 };
    }
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
    const { data } = await this.client.GET('/session/filter', {});
    return data?.sql ?? null;
  }

  async getWorldspaces(plugin: string): Promise<WorldspaceSummary[]> {
    try {
      const { data } = await this.client.GET('/plugins/{plugin}/worldspaces', {
        params: { path: { plugin } },
      });
      return (data ?? []).map((w: GenWorldspace) => ({
        formKey: w.formKey ?? '',
        editorId: w.editorId ?? null,
      }));
    } catch (e) {
      this.log(`[PluginRepository] getWorldspaces(${plugin}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  async getWorldspaceBlocks(plugin: string, worldspaceFormKey: string): Promise<WorldspaceBlocks> {
    try {
      const { data } = await this.client.GET('/plugins/{plugin}/worldspaces/{formKey}/blocks', {
        params: { path: { plugin, formKey: worldspaceFormKey } },
      });
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
    } catch (e) {
      this.log(`[PluginRepository] getWorldspaceBlocks(${plugin}, ${worldspaceFormKey}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return { blocks: [], topCell: null };
    }
  }

  async getCellReferences(plugin: string, cellFormKey: string): Promise<CellReferences> {
    try {
      const { data } = await this.client.GET('/plugins/{plugin}/cells/{formKey}/references', {
        params: { path: { plugin, formKey: cellFormKey } },
      });
      return {
        persistent: (data?.persistent ?? []).map(toPlacedSummary),
        temporary: (data?.temporary ?? []).map(toPlacedSummary),
      };
    } catch (e) {
      this.log(`[PluginRepository] getCellReferences(${plugin}, ${cellFormKey}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return { persistent: [], temporary: [] };
    }
  }

  async getInteriorCells(plugin: string, offset: number, limit: number): Promise<CellPage> {
    try {
      const { data } = await this.client.GET('/plugins/{plugin}/interior-cells', {
        params: { path: { plugin }, query: { offset, limit } },
      });
      return {
        items: (data?.items ?? []).map(toCellSummary),
        total: data?.total ?? 0,
      };
    } catch (e) {
      this.log(`[PluginRepository] getInteriorCells(${plugin}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return { items: [], total: 0 };
    }
  }
}
