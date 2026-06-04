import type { components } from './generated/api';
import type { ApiClient, PluginMetadata, RecordSummary } from './ApiClient';

type PluginResponse = components['schemas']['PluginResponse'];
type GeneratedRecordSummary = components['schemas']['RecordSummary'];
type RecordSummaryPagedResult = components['schemas']['RecordSummaryPagedResult'];
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

export interface RecordPage {
  items: RecordSummary[];
  total: number;
}

export interface PluginRepository {
  getPlugins(): Promise<PluginMetadata[]>;
  getRecordTypes(plugin: string): Promise<{ type: string; count: number }[]>;
  getRecords(plugin: string, type: string, offset: number, limit: number): Promise<RecordPage>;
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
}
