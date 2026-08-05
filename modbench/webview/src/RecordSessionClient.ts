import { createApiClient } from '../../src/medit/ApiClient';
import type { CompareResult, PendingChange } from './types';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, type LogLevel } from './messages';

// Mirrors RecordPanel's own logAction — this module has no component instance to hang a callback
// off of, but the bridge is the same one-line postMessage either way.
function log(level: LogLevel, message: string) {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level, message });
}

// Issue #122: the record panel's plugin list — a structural subset of the backend's
// PluginResponse, kept minimal because the panel only needs name / immutability / order.
export interface PluginInfo {
  name: string;
  isImmutable: boolean;
  loadOrderIndex: number;
}

// Issue #122: the composite view for a single record. `load` fires compare + changes + plugins
// in parallel; a compare failure fails the whole load (the panel has nothing to show), while a
// changes/plugins failure comes back as `null` so the panel leaves that slice of state
// untouched — preserving the pre-seam behavior where only the parts that succeeded were applied.
// The immutable set is resolved from the plugin list here (behind the client), null when plugins
// failed, so the panel doesn't re-derive it. #209: the raw plugin list itself (`PluginInfo[]`) is
// no longer exposed on this type — its only consumer was RecordPanel's own `allPlugins` state,
// which fed the now-deleted PluginTargetPicker/Add Master dropdown; target-plugin resolution for
// the column-header menu happens via a VS Code QuickPick in the extension host now, which asks
// PluginRepository directly rather than through this webview-side client.
export type LoadResult =
  | { ok: true; result: CompareResult; changes: PendingChange[] | null; immutableSet: Set<string> | null }
  | { ok: false; error: string };

// Issue #122: the webview-side typed backend client. Owns every backend call the record panel
// makes — mirrors the host-side ApiClient (openapi-fetch over the generated `paths` types), so
// there are no hand-built URL strings or stringly-typed request shapes. Read choreography (load)
// is fully parsed here; writes return the raw Response so the panel keeps its existing
// status-code / body-shape error handling verbatim. #210: searchRecords moved off this client —
// the FormKey picker it backed is a native QuickPick now, and its search runs in the extension
// host via PluginRepository.searchRecords instead of round-tripping through this webview.
export interface RecordSessionClient {
  load(formKey: string): Promise<LoadResult>;
  save(formKey: string, plugin: string, fields: Record<string, unknown>, changeType?: string): Promise<Response>;
  revert(changeId: string): Promise<Response>;
  copyTo(formKey: string, targetPlugin: string): Promise<Response>;
  removeOverride(formKey: string, plugin: string): Promise<Response>;
  createRecord(plugin: string, recordType?: string): Promise<Response>;
  // Issue #139: the changes in the whole component `changeId` belongs to (ADR-0028). Read fully
  // here (not a raw Response) because the panel only needs the member list to decide the Revert
  // Group confirmation; a failed read yields [] so the panel falls back to a plain single-change
  // revert.
  groupMembers(changeId: string): Promise<PendingChange[]>;
  // Issue #139: save/revert the whole component a member change belongs to. Both return the raw
  // Response so the panel reads the SaveGroupResponse body / status itself (ADR-0026 surfacing).
  saveGroup(changeId: string): Promise<Response>;
  // Issue #211: revertGroup is the last write here — the condition-function picker's catalog
  // (formerly `conditionFunctions()` above) moved off this client entirely. It's a native
  // QuickPick now, fetched in the extension host via PluginRepository.getConditionFunctions()
  // instead of round-tripping through this webview, same as #210's searchRecords removal.
  revertGroup(changeId: string): Promise<Response>;
  // Issue #167: the Run On target dropdown's catalog — unlike the function catalog above, this
  // one *does* stay on this client: it feeds ConditionRunOnCell's own inline `<select>` rendered
  // in this webview (not a native QuickPick), so this webview needs the list itself, the same way
  // it already reads `/plugins`/`/changes` directly rather than round-tripping through the
  // extension host. Session-wide, not per-record, so RecordPanel fetches it once rather than on
  // every load().
  conditionRunOnTargets(): Promise<string[]>;
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
        immutableSet: pluginList ? new Set(pluginList.filter(p => p.isImmutable).map(p => p.name)) : null,
      };
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

    async groupMembers(changeId) {
      // `groupId` selects the whole component the named change belongs to (ADR-0028); the param
      // name is the backend's, but any member id resolves the same component. A failed read is
      // not fatal — the panel only needs the count to choose the Revert Group confirmation, and
      // falling back to [] means it takes the no-confirmation path, never a raw 409.
      const { data, response } = await client.GET('/changes', { params: { query: { groupId: changeId } } });
      return response.ok ? (data as PendingChange[]) : [];
    },

    saveGroup(changeId) {
      return rawWrite(fetchImpl => client.POST('/change-groups/{groupId}/save', {
        params: { path: { groupId: changeId } },
        parseAs: 'stream',
        fetch: fetchImpl,
      }));
    },

    revertGroup(changeId) {
      return rawWrite(fetchImpl => client.DELETE('/changes/group/{groupId}', {
        params: { path: { groupId: changeId } },
        parseAs: 'stream',
        fetch: fetchImpl,
      }));
    },

    // Issue #167 (review): mirrors PluginRepository.getConditionFunctions()'s own contract —
    // never rejects, logs on both failure paths (a non-ok response and a thrown network error)
    // rather than swallowing either silently, then degrades to [] (the Run On dropdown simply
    // has no options to show, the same "background/recoverable" severity a tree-fetch blip gets,
    // not a blocking notification — ADR-0026).
    async conditionRunOnTargets() {
      try {
        const { data, response } = await client.GET('/condition-run-on-targets', {});
        if (!response.ok) {
          log('warn', `conditionRunOnTargets failed (${response.status})`);
          return [];
        }
        return data ?? [];
      } catch (e) {
        log('warn', `conditionRunOnTargets failed: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    },
  };
}
