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

export function createApiClient(port: number) {
  return createClient<paths>({ baseUrl: `http://localhost:${port}` });
}
