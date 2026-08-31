import { createApiClient } from '../../src/medit/ApiClient';
import type { ColumnKey, CompareResult } from './types';
import { columnKey } from './types';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, type LogLevel } from './messages';


// Mirrors RecordPanel's own logAction — this module has no component instance to hang a callback
// off of, but the bridge is the same one-line postMessage either way.
function log(level: LogLevel, message: string) {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level, message });
}

// The record panel's plugin list — a structural subset of the backend's
// PluginResponse, kept minimal because the panel only needs name / immutability / order.
export interface PluginInfo {
  name: string;
  isImmutable: boolean;
  loadOrderIndex: number;
  // ADR-0036: needed to key immutableSet by compound column identity. Required —
  // every construction must say which origin, not rely on columnKey() eliding a missing one to
  // the Data origin.
  origin: string;
  // ADR-0035: whether the effective load order actually names this copy (PluginResponse.
  // InLoadOrder — false only for a plugin AddUnlistedPlugin opened on demand). Distinct from
  // isImmutable: a vanilla/DLC master is immutable and still true here, while a shadowed copy is
  // immutable *because* this is false — PluginHeader needs both to word its tooltip and decide
  // whether to dim (see recordUtils.ts's readOnlyReason).
  inLoadOrder: boolean;
  // ADR-0041: whether this plugin's mod folder is tracked. Editing requires tracking;
  // viewing never does — so this is what lets the panel render a column as visibly read-only with
  // the way out named, instead of only discovering it on a refused attempt.
  isTracked: boolean;
}

// The composite view for a single record. `load` fires compare + changes + plugins
// in parallel; a compare failure fails the whole load (the panel has nothing to show), while a
// changes/plugins failure comes back as `null` so the panel leaves that slice of state
// untouched — only the parts that succeeded are applied.
// The immutable set is resolved from the plugin list here (behind the client), null when plugins
// failed, so the panel doesn't re-derive it. The raw plugin list itself (`PluginInfo[]`) is
// not exposed on this type — target-plugin resolution for
// the column-header menu happens via a VS Code QuickPick in the extension host, which asks
// PluginRepository directly rather than through this webview-side client.
export type LoadResult =
  | {
      ok: true; result: CompareResult; immutableSet: Set<ColumnKey> | null;
      // ADR-0035: mirrors immutableSet's own construction (same PluginInfo list, same
      // columnKey() keying) — null exactly when immutableSet is (the /plugins fetch itself
      // failed), never independently.
      notInLoadOrderSet: Set<ColumnKey> | null;
      // The columns whose plugin's mod is tracked. Null exactly when immutableSet is (the
      // /plugins fetch failed) — but note the *safe* direction is the opposite one here: a
      // mutability set degrades to "unrestricted", while this degrades to "nothing is editable",
      // because wrongly offering an edit that cannot land is worse than wrongly withholding one
      // the user can get back with a click (ADR-0026). RecordPanel reads it fail-closed.
      trackedSet: Set<ColumnKey> | null;
      // ADR-0035: whether the winner sweep has run — GET /load-order/status's own field,
      // read here rather than left for the extension host to relay (the webview already talks to
      // the backend directly for every other fact this composite view needs). Required, not
      // nullable like immutableSet/notInLoadOrderSet above: those degrade to "unrestricted" on a
      // failed fetch (the safe direction for a mutability guard), but this one must fail *closed*
      // — an absent answer has to read as "not computed", never as "settled", or a status-fetch
      // blip would render a settled-looking grid over a comparison nothing actually checked
      // (ADR-0026 / ADR-0035: "an absent conflict badge must never be mistakable for 'no
      // conflict'").
      conflictsComputed: boolean;
    }
  | { ok: false; error: string };

// The webview-side typed backend client. Owns every backend call the record panel
// makes — mirrors the host-side ApiClient (openapi-fetch over the generated `paths` types), so
// there are no hand-built URL strings or stringly-typed request shapes. ADR-0041: reads only.
// Writes stay off this client
// because a refusal has to become a native notification, and only the extension host can show one —
// so an edit travels webview -> host -> backend, and this client carries reads only.
// searchRecords is likewise absent — the FormKey picker it would back is a native QuickPick, and
// its search runs in the extension host via PluginRepository.searchRecords instead of
// round-tripping through this webview.
export interface RecordPanelClient {
  load(formKey: string): Promise<LoadResult>;
  // The Run On target dropdown's catalog — feeds ConditionRunOnCell's own inline
  // `<select>` rendered in this webview (not a native QuickPick), so this webview needs the list
  // itself, the same way it already reads `/plugins` directly rather than round-tripping through
  // the extension host. Load-order-wide, not per-record, so RecordPanel fetches it once rather than
  // on every load().
  conditionRunOnTargets(): Promise<string[]>;
}

export function createRecordPanelClient(port: number): RecordPanelClient {
  const client = createApiClient(port);

  return {
    async load(formKey) {
      const [cmp, plugins, status] = await Promise.all([
        client.GET('/records/{formKey}/compare', { params: { path: { formKey } } }),
        client.GET('/plugins'),
        // ADR-0035: the same GET /load-order/status the tree poll already reads, fetched
        // directly here rather than round-tripped through the extension host — see load()'s own
        // reasoning for /plugins above.
        client.GET('/load-order/status', {}),
      ]);
      if (!cmp.response.ok) return { ok: false, error: `HTTP ${cmp.response.status}` };
      const pluginList = plugins.response.ok ? (plugins.data as PluginInfo[]) : null;
      return {
        ok: true,
        result: cmp.data as CompareResult,
        // ADR-0036: keyed by compound column identity, not bare plugin name — two
        // PluginInfo entries sharing a filename but differing in origin must stay distinct
        // Set members, or one origin's mutability silently wins for both (RecordPanel.tsx's
        // immutableSet.has(...) checks).
        immutableSet: pluginList ? new Set(pluginList.filter(p => p.isImmutable).map(p => columnKey(p.name, p.origin))) : null,
        // ADR-0035: same compound-identity keying as immutableSet, filtered the other
        // direction — `=== false` (not `!p.inLoadOrder`) so a response missing the field (an
        // older/stale shape) defaults every column to in-load-order, the overwhelmingly common
        // case, rather than every plugin silently reading as shadowed.
        notInLoadOrderSet: pluginList ? new Set(pluginList.filter(p => p.inLoadOrder === false).map(p => columnKey(p.name, p.origin))) : null,
        // `=== true`, not a truthiness test — a response missing the field (an older or
        // stale backend) must read as "not tracked" for every column, which withholds editing
        // rather than offering one that cannot land. Same fail-closed reasoning as
        // conflictsComputed below, opposite direction to immutableSet above.
        trackedSet: pluginList ? new Set(pluginList.filter(p => p.isTracked === true).map(p => columnKey(p.name, p.origin))) : null,
        // Fails closed — `=== true`, not `?? true`, so a failed/absent status fetch reads
        // as "not computed" (see LoadResult's own doc comment on this field).
        conflictsComputed: status.response.ok && status.data?.conflictsComputed === true,
      };
    },

    // Mirrors PluginRepository.getConditionFunctions()'s own contract —
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
