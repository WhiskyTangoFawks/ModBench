import { createApiClient } from '../../src/medit/ApiClient';
import type { components } from '../../src/medit/generated/api';
import type { CompareResult, PatchRecordValidationError, PendingChange } from './types';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, type LogLevel } from './messages';

type ProblemDetails = components['schemas']['ProblemDetails'];
type CreateRecordResult = components['schemas']['CreateRecordResult'];
type DeleteRecordsResponse = components['schemas']['DeleteRecordsResponse'];
type SaveGroupResponse = components['schemas']['SaveGroupResponse'];

// #163: the typed alternative to a hand-parsed raw Response — every write method resolves to
// this instead. Mirrors LoadResult's own discriminated-union shape (below `load`'s own return
// type) rather than exposing openapi-fetch's native `{ data, error, response }` triple verbatim:
// every caller already branches on ok/status, so this is a direct rename of that branch, and
// `status`/`error` stay readable without reaching through `response`.
export type WriteResult<TData, TError> =
  | { ok: true; data: TData }
  | { ok: false; status: number; error: TError };

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
// is fully parsed here; writes resolve to a typed `WriteResult` (#163) so the panel branches on
// `ok`/`status`/`error` instead of hand-parsing a raw Response body. #210: searchRecords moved
// off this client — the FormKey picker it backed is a native QuickPick now, and its search runs
// in the extension host via PluginRepository.searchRecords instead of round-tripping through
// this webview.
export interface RecordSessionClient {
  load(formKey: string): Promise<LoadResult>;
  save(
    formKey: string, plugin: string, fields: Record<string, unknown>, changeType?: string,
  ): Promise<WriteResult<PendingChange[], ProblemDetails | PatchRecordValidationError>>;
  revert(changeId: string): Promise<WriteResult<undefined, ProblemDetails>>;
  // Issue #202: sourcePlugin, when given, copies that plugin's own version of the record (the
  // column-header menu's right-clicked column) rather than the overall winner.
  copyTo(
    formKey: string, targetPlugin: string, sourcePlugin?: string,
  ): Promise<WriteResult<PendingChange[], ProblemDetails | PatchRecordValidationError>>;
  removeOverride(formKey: string, plugin: string): Promise<WriteResult<DeleteRecordsResponse, ProblemDetails>>;
  createRecord(plugin: string, recordType?: string): Promise<WriteResult<CreateRecordResult, ProblemDetails>>;
  // Issue #139: the changes in the whole component `changeId` belongs to (ADR-0028). Read fully
  // here (not a raw Response) because the panel only needs the member list to decide the Revert
  // Group confirmation; a failed read yields [] so the panel falls back to a plain single-change
  // revert.
  groupMembers(changeId: string): Promise<PendingChange[]>;
  // Issue #139: save/revert the whole component a member change belongs to. Both resolve to a
  // typed WriteResult so the panel reads the SaveGroupResponse data / status itself (ADR-0026
  // surfacing).
  saveGroup(changeId: string): Promise<WriteResult<SaveGroupResponse, ProblemDetails>>;
  // Issue #211: revertGroup is the last write here — the condition-function picker's catalog
  // (formerly `conditionFunctions()` above) moved off this client entirely. It's a native
  // QuickPick now, fetched in the extension host via PluginRepository.getConditionFunctions()
  // instead of round-tripping through this webview, same as #210's searchRecords removal.
  revertGroup(changeId: string): Promise<WriteResult<undefined, ProblemDetails>>;
  // Issue #167: the Run On target dropdown's catalog — unlike the function catalog above, this
  // one *does* stay on this client: it feeds ConditionRunOnCell's own inline `<select>` rendered
  // in this webview (not a native QuickPick), so this webview needs the list itself, the same way
  // it already reads `/plugins`/`/changes` directly rather than round-tripping through the
  // extension host. Session-wide, not per-record, so RecordPanel fetches it once rather than on
  // every load().
  conditionRunOnTargets(): Promise<string[]>;
}

// #163: adapts an openapi-fetch call's own `{ data, error, response }` triple into WriteResult.
// Supersedes the old rawWrite/capture-fetch hack — that existed only so the panel could
// hand-parse a raw Response body itself; now that callers consume the typed `data`/`error`
// openapi-fetch already parses, there is no raw body left to protect from being drained. Module
// scope (not a closure inside createRecordSessionClient) since it captures nothing but its args.
// TData/TError are explicit at each call site (not inferred from `call`, which is deliberately
// `unknown`-shaped here) because the generated per-operation schema types (all-optional, mirroring
// C# nullable reference types) are looser than this webview's own hand-declared DTOs (`./types`)
// — the same narrowing `load()` above already does with its own `as CompareResult`/`as
// PendingChange[]` casts.
async function write<TData, TError>(
  call: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<WriteResult<TData, TError>> {
  const { data, error, response } = await call;
  return response.ok
    ? { ok: true, data: data as TData }
    : { ok: false, status: response.status, error: error as TError };
}

export function createRecordSessionClient(port: number): RecordSessionClient {
  const client = createApiClient(port);

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
      return write<PendingChange[], ProblemDetails | PatchRecordValidationError>(client.PATCH('/records/{formKey}', {
        params: { path: { formKey } },
        body: { plugin, fields, source: 'user', ...(changeType ? { changeType } : {}) },
      }));
    },

    revert(changeId) {
      return write<undefined, ProblemDetails>(client.DELETE('/changes/{changeId}', {
        params: { path: { changeId } },
      }));
    },

    copyTo(formKey, targetPlugin, sourcePlugin) {
      return write<PendingChange[], ProblemDetails | PatchRecordValidationError>(
        client.POST('/records/{formKey}/copy-to/{targetPlugin}', {
          params: { path: { formKey, targetPlugin } },
          body: sourcePlugin ? { sourcePlugin } : {},
        }),
      );
    },

    removeOverride(formKey, plugin) {
      return write<DeleteRecordsResponse, ProblemDetails>(client.POST('/records/delete', {
        body: { records: [{ formKey, plugin }] },
      }));
    },

    createRecord(plugin, recordType) {
      return write<CreateRecordResult, ProblemDetails>(client.POST('/plugins/{plugin}/records', {
        params: { path: { plugin } },
        body: { source: 'user', ...(recordType ? { recordType } : {}) },
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
      return write<SaveGroupResponse, ProblemDetails>(client.POST('/change-groups/{groupId}/save', {
        params: { path: { groupId: changeId } },
      }));
    },

    revertGroup(changeId) {
      return write<undefined, ProblemDetails>(client.DELETE('/changes/group/{groupId}', {
        params: { path: { groupId: changeId } },
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
