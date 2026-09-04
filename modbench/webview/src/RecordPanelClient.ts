import { createApiClient } from '../../src/medit/ApiClient';
import type { ColumnKey, CompareResult } from './types';
import { columnKey } from './types';
// `load` fires compare + plugins + status in parallel: a compare failure fails the whole load
// (the panel has nothing to show), while a plugins/status failure comes back as `null` so the
// panel leaves that slice of state untouched.
export type LoadResult =
  | {
      ok: true; result: CompareResult; immutableSet: Set<ColumnKey> | null;
      // ADR-0035: mirrors immutableSet's own construction (same plugin list, same
      // columnKey() keying) — null exactly when immutableSet is (the /plugins fetch itself
      // failed), never independently.
      notInLoadOrderSet: Set<ColumnKey> | null;
      // Null exactly when immutableSet is, but degrading the opposite way: to "nothing is
      // editable", because wrongly offering an edit that cannot land is worse than wrongly
      // withholding one (ADR-0026). Read fail-closed.
      trackedSet: Set<ColumnKey> | null;
      // ADR-0035: whether the winner sweep has run. Must fail *closed* — an absent answer has to
      // read as "not computed", never as "settled", or a status-fetch blip would render a
      // settled-looking grid over a comparison nothing checked.
      conflictsComputed: boolean;
    }
  | { ok: false; error: string };

// Mirrors the host-side ApiClient (openapi-fetch over the generated `paths` types), so no URL
// strings are hand-built. ADR-0041: reads only — a refusal has to become a native notification,
// and only the extension host can show one.
export interface RecordPanelClient {
  load(formKey: string): Promise<LoadResult>;
}

export function createRecordPanelClient(port: number): RecordPanelClient {
  const client = createApiClient(port);

  return {
    async load(formKey) {
      const [cmp, plugins, status] = await Promise.all([
        client.GET('/records/{formKey}/compare', { params: { path: { formKey } } }),
        client.GET('/plugins'),
        // ADR-0035: the same GET /load-order/status the tree poll reads, fetched directly here
        // rather than round-tripped through the extension host.
        client.GET('/load-order/status', {}),
      ]);
      if (!cmp.response.ok) return { ok: false, error: `HTTP ${cmp.response.status}` };
      // No cast — this is the generated PluginResponse[] straight off the client.
      const pluginList = plugins.response.ok ? (plugins.data ?? null) : null;
      return {
        ok: true,
        // A *narrowing* to the webview's own refinement of the wire — `FieldMetadata.type` is a
        // closed union here and `string` on the wire, so wire -> webview is a downcast by
        // construction.
        result: cmp.data as CompareResult,
        // ADR-0036: keyed by compound column identity, not bare plugin name — two entries sharing
        // a filename but differing in origin must stay distinct Set members, or one origin's
        // mutability silently wins for both.
        immutableSet: pluginList ? new Set(pluginList.filter(p => p.isImmutable).map(p => columnKey(p.name, p.origin))) : null,
        // ADR-0035: same compound-identity keying as immutableSet, filtered the other direction.
        // Both flags are required non-nullable booleans on the wire, and the extension spawns its
        // own bundled backend (ADR-0022), so version skew is unreachable.
        notInLoadOrderSet: pluginList ? new Set(pluginList.filter(p => !p.inLoadOrder).map(p => columnKey(p.name, p.origin))) : null,
        trackedSet: pluginList ? new Set(pluginList.filter(p => p.isTracked).map(p => columnKey(p.name, p.origin))) : null,
        // Fails closed — `=== true`, not `?? true`, so a failed or absent status fetch reads as
        // "not computed".
        conflictsComputed: status.response.ok && status.data?.conflictsComputed === true,
      };
    },
  };
}
