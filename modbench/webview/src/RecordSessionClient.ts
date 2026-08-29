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

// Issue #122: the record panel's plugin list — a structural subset of the backend's
// PluginResponse, kept minimal because the panel only needs name / immutability / order.
export interface PluginInfo {
  name: string;
  isImmutable: boolean;
  loadOrderIndex: number;
  // #272 / ADR-0036: needed to key immutableSet by compound column identity. Required (#275) —
  // every construction must say which origin, not rely on columnKey() eliding a missing one to
  // the Data origin.
  origin: string;
  // #304 / ADR-0035: whether the effective load order actually names this copy (PluginResponse.
  // InLoadOrder — false only for a plugin AddUnlistedPlugin opened on demand). Distinct from
  // isImmutable: a vanilla/DLC master is immutable and still true here, while a shadowed copy is
  // immutable *because* this is false — PluginHeader needs both to word its tooltip and decide
  // whether to dim (see recordUtils.ts's readOnlyReason).
  inLoadOrder: boolean;
  // #415 / ADR-0041: whether this plugin's mod folder is tracked. Editing requires tracking;
  // viewing never does — so this is what lets the panel render a column as visibly read-only with
  // the way out named, instead of only discovering it on a refused attempt.
  isTracked: boolean;
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
  | {
      ok: true; result: CompareResult; immutableSet: Set<ColumnKey> | null;
      // #304 / ADR-0035: mirrors immutableSet's own construction (same PluginInfo list, same
      // columnKey() keying) — null exactly when immutableSet is (the /plugins fetch itself
      // failed), never independently.
      notInLoadOrderSet: Set<ColumnKey> | null;
      // #415: the columns whose plugin's mod is tracked. Null exactly when immutableSet is (the
      // /plugins fetch failed) — but note the *safe* direction is the opposite one here: a
      // mutability set degrades to "unrestricted", while this degrades to "nothing is editable",
      // because wrongly offering an edit that cannot land is worse than wrongly withholding one
      // the user can get back with a click (ADR-0026). RecordPanel reads it fail-closed.
      trackedSet: Set<ColumnKey> | null;
      // #308 / ADR-0035: whether the winner sweep has run — GET /session/status's own field,
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

// Issue #122: the webview-side typed backend client. Owns every backend call the record panel
// makes — mirrors the host-side ApiClient (openapi-fetch over the generated `paths` types), so
// there are no hand-built URL strings or stringly-typed request shapes. #410/ADR-0041: reads only.
// Every write method it used to carry retired with the endpoints behind them. #415 kept it that
// way, but not for the reason predicted here before the fact: the edit path is a real HTTP endpoint
// (POST /records/{formKey}/field), not files edited out of band. Writes stay off this client
// because a refusal has to become a native notification, and only the extension host can show one —
// so an edit travels webview -> host -> backend, and this client keeps carrying reads only.
// #210: searchRecords moved
// off this client — the FormKey picker it backed is a native QuickPick now, and its search runs
// in the extension host via PluginRepository.searchRecords instead of round-tripping through
// this webview.
// #544: "Compare with winner" — the plugin + peer/winner origin pair `load` scopes its own
// `overrides` to when given, dropping every other participating column GetCompare would otherwise
// include (a genuine third-party conflict on the same FormKey, say). Absent for every ordinary
// open. `plugin` is required, not inferred from the two origins: an origin alone doesn't name a
// column — the peer's own mod folder can ship a second plugin file that independently overrides
// this same FormKey under that same origin, and filtering by origin alone would let that unrelated
// row back in as a bogus third column, exactly the case this scoping exists to exclude.
export interface DeltaScope {
  plugin: string;
  winnerOrigin: string;
  peerOrigin: string;
}

export interface RecordSessionClient {
  load(formKey: string, deltaScope?: DeltaScope): Promise<LoadResult>;
  // Issue #167: the Run On target dropdown's catalog — feeds ConditionRunOnCell's own inline
  // `<select>` rendered in this webview (not a native QuickPick), so this webview needs the list
  // itself, the same way it already reads `/plugins` directly rather than round-tripping through
  // the extension host. Session-wide, not per-record, so RecordPanel fetches it once rather than
  // on every load().
  conditionRunOnTargets(): Promise<string[]>;
}

export function createRecordSessionClient(port: number): RecordSessionClient {
  const client = createApiClient(port);

  return {
    async load(formKey, deltaScope) {
      const [cmp, plugins, status] = await Promise.all([
        client.GET('/records/{formKey}/compare', { params: { path: { formKey } } }),
        client.GET('/plugins'),
        // #308 / ADR-0035: the same GET /session/status #307's tree poll already reads, fetched
        // directly here rather than round-tripped through the extension host — see load()'s own
        // reasoning for /plugins above.
        client.GET('/session/status', {}),
      ]);
      if (!cmp.response.ok) return { ok: false, error: `HTTP ${cmp.response.status}` };
      const pluginList = plugins.response.ok ? (plugins.data as PluginInfo[]) : null;
      const compareResult = cmp.data as CompareResult;
      // #544: scoped here, not in RecordPanel — every downstream derivation that reads
      // result.overrides (columns, editableColumns, collidingPluginNames, ...) then "just works"
      // against the already-scoped set with no changes of its own.
      const scopedOverrides = deltaScope
        ? compareResult.overrides.filter(o =>
            o.plugin === deltaScope.plugin && (o.origin === deltaScope.winnerOrigin || o.origin === deltaScope.peerOrigin))
        : compareResult.overrides;
      return {
        ok: true,
        result: { ...compareResult, overrides: scopedOverrides },
        // #272 / ADR-0036: keyed by compound column identity, not bare plugin name — two
        // PluginInfo entries sharing a filename but differing in origin must stay distinct
        // Set members, or one origin's mutability silently wins for both (RecordPanel.tsx's
        // immutableSet.has(...) checks).
        immutableSet: pluginList ? new Set(pluginList.filter(p => p.isImmutable).map(p => columnKey(p.name, p.origin))) : null,
        // #304 / ADR-0035: same compound-identity keying as immutableSet, filtered the other
        // direction — `=== false` (not `!p.inLoadOrder`) so a response missing the field (an
        // older/stale shape) defaults every column to in-load-order, the overwhelmingly common
        // case, rather than every plugin silently reading as shadowed.
        notInLoadOrderSet: pluginList ? new Set(pluginList.filter(p => p.inLoadOrder === false).map(p => columnKey(p.name, p.origin))) : null,
        // #415: `=== true`, not a truthiness test — a response missing the field (an older or
        // stale backend) must read as "not tracked" for every column, which withholds editing
        // rather than offering one that cannot land. Same fail-closed reasoning as
        // conflictsComputed below, opposite direction to immutableSet above.
        trackedSet: pluginList ? new Set(pluginList.filter(p => p.isTracked === true).map(p => columnKey(p.name, p.origin))) : null,
        // #308: fails closed — `=== true`, not `?? true`, so a failed/absent status fetch reads
        // as "not computed" (see LoadResult's own doc comment on this field).
        conflictsComputed: status.response.ok && status.data?.conflictsComputed === true,
      };
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
