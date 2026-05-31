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
  constructor(private readonly client: ApiClient) {}

  async getPlugins(): Promise<PluginMetadata[]> {
    const { data } = await this.client.GET('/plugins', {});
    const raw = (data as PluginResponse[] | undefined) ?? [];
    return raw.map(toPluginMetadata);
  }

  async getRecordTypes(plugin: string): Promise<{ type: string; count: number }[]> {
    const { data } = await this.client.GET('/plugins/{plugin}/record-types', {
      params: { path: { plugin } },
    });
    const raw = (data as PluginRecordTypeCount[] | undefined) ?? [];
    return raw.map(toRecordTypeCount);
  }

  async getRecords(plugin: string, type: string, offset: number, limit: number): Promise<RecordPage> {
    const { data } = await this.client.GET('/records', {
      params: { query: { plugin, type, offset, limit } },
    });
    const raw = data as RecordSummaryPagedResult | undefined;
    return {
      items: (raw?.items ?? []).map(toRecordSummary),
      total: raw?.total ?? 0,
    };
  }
}
