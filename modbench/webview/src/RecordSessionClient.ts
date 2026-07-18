import { createApiClient } from '../../src/medit/ApiClient';
import type { CompareResult, PendingChange } from './types';

// Issue #122: the record panel's plugin list — a structural subset of the backend's
// PluginResponse, kept minimal because the panel only needs name / immutability / order.
export interface PluginInfo {
  name: string;
  isImmutable: boolean;
  loadOrderIndex: number;
}

export interface FormKeySearchResult {
  formKey: string;
  editorId: string | null;
}

// Issue #122: the composite view for a single record. `load` fires compare + changes + plugins
// in parallel; a compare failure fails the whole load (the panel has nothing to show), while a
// changes/plugins failure comes back as `null` so the panel leaves that slice of state
// untouched — preserving the pre-seam behavior where only the parts that succeeded were applied.
// The immutable set is resolved from the plugin list here (behind the client), null when plugins
// failed, so the panel doesn't re-derive it.
export type LoadResult =
  | { ok: true; result: CompareResult; changes: PendingChange[] | null; plugins: PluginInfo[] | null; immutableSet: Set<string> | null }
  | { ok: false; error: string };

// Issue #122: the webview-side typed backend client. Owns every backend call the record panel
// makes — mirrors the host-side ApiClient (openapi-fetch over the generated `paths` types), so
// there are no hand-built URL strings or stringly-typed request shapes. Read choreography
// (load, searchRecords) is fully parsed here; writes return the raw Response so the panel keeps
// its existing status-code / body-shape error handling verbatim.
export interface RecordSessionClient {
  load(formKey: string): Promise<LoadResult>;
  searchRecords(query: string, validTypes: string[], signal?: AbortSignal): Promise<FormKeySearchResult[]>;
  save(formKey: string, plugin: string, fields: Record<string, unknown>, changeType?: string): Promise<Response>;
  revert(changeId: string): Promise<Response>;
  copyTo(formKey: string, targetPlugin: string): Promise<Response>;
  removeOverride(formKey: string, plugin: string): Promise<Response>;
  createRecord(plugin: string, recordType?: string): Promise<Response>;
}

export function createRecordSessionClient(port: number): RecordSessionClient {
  const client = createApiClient(port);

  // Write methods must return an *unconsumed* Response so the panel can read the 409/422 body
  // itself: openapi-fetch consumes the body on the error path (response.text()) regardless of
  // parseAs, so a returned response would already be drained. A per-call fetch override does the
  // real request, hands openapi-fetch a clone to consume, and keeps the original intact for us.
  async function rawWrite(send: (fetchImpl: typeof globalThis.fetch) => Promise<unknown>): Promise<Response> {
    let raw!: Response;
    const capture: typeof globalThis.fetch = async (input, init) => {
      raw = await globalThis.fetch(input, init);
      return raw.clone();
    };
    await send(capture);
    return raw;
  }

  return {
    async load(formKey) {
      const [cmp, chg, plugins] = await Promise.all([
        client.GET('/records/{formKey}/compare', { params: { path: { formKey } } }),
        client.GET('/changes', { params: { query: { formKey } } }),
        client.GET('/plugins'),
      ]);
      if (!cmp.response.ok) return { ok: false, error: `HTTP ${cmp.response.status}` };
      const pluginList = plugins.response.ok ? (plugins.data as PluginInfo[]) : null;
      return {
        ok: true,
        result: cmp.data as CompareResult,
        changes: chg.response.ok ? (chg.data as PendingChange[]) : null,
        plugins: pluginList,
        immutableSet: pluginList ? new Set(pluginList.filter(p => p.isImmutable).map(p => p.name)) : null,
      };
    },

    async searchRecords(query, validTypes, signal) {
      const { data, response } = await client.GET('/records', {
        params: {
          query: {
            search: query,
            ...(validTypes.length === 1 ? { type: validTypes[0] } : {}),
            limit: 20,
          },
        },
        signal,
      });
      // A failed (non-abort) search throws rather than returning [], so the picker's catch leaves
      // the prior results visible — matching the pre-seam `if (!r.ok) return` (no state update).
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (data?.items ?? []) as FormKeySearchResult[];
    },

    save(formKey, plugin, fields, changeType) {
      return rawWrite(fetchImpl => client.PATCH('/records/{formKey}', {
        params: { path: { formKey } },
        body: { plugin, fields, source: 'user', ...(changeType ? { changeType } : {}) },
        parseAs: 'stream',
        fetch: fetchImpl,
      }));
    },

    revert(changeId) {
      return rawWrite(fetchImpl => client.DELETE('/changes/{changeId}', {
        params: { path: { changeId } },
        parseAs: 'stream',
        fetch: fetchImpl,
      }));
    },

    copyTo(formKey, targetPlugin) {
      return rawWrite(fetchImpl => client.POST('/records/{formKey}/copy-to/{targetPlugin}', {
        params: { path: { formKey, targetPlugin } },
        body: {},
        parseAs: 'stream',
        fetch: fetchImpl,
      }));
    },

    removeOverride(formKey, plugin) {
      return rawWrite(fetchImpl => client.POST('/records/delete', {
        body: { records: [{ formKey, plugin }] },
        parseAs: 'stream',
        fetch: fetchImpl,
      }));
    },

    createRecord(plugin, recordType) {
      return rawWrite(fetchImpl => client.POST('/plugins/{plugin}/records', {
        params: { path: { plugin } },
        body: { source: 'user', ...(recordType ? { recordType } : {}) },
        parseAs: 'stream',
        fetch: fetchImpl,
      }));
    },
  };
}
