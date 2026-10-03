import type { ColumnKey, CompareResult, PluginLoadFailure } from './types';
import { columnKey } from './columnKey';
import { parseCompareResult } from './parseCompareResult';
import { requestRecordLoad } from './nativeBridge';

// `load` asks the host for compare, plugins and status in one round trip: a compare failure fails
// the whole load, while a plugins/status failure comes back as `null` so the panel leaves that
// slice of state untouched.
export type LoadResult =
  | {
      // Null is a record held by no active plugin.
      ok: true; result: CompareResult | null; immutableSet: Set<ColumnKey> | null;
      // Null exactly when immutableSet is, but degrading the opposite way: to "nothing is
      // editable", because wrongly offering an edit that cannot land is worse than wrongly
      // withholding one (ADR-0019). Read fail-closed.
      trackedSet: Set<ColumnKey> | null;
      // Whether the winner sweep has run (editor.md, States, story 3). Fails *closed*: an absent
      // answer reads as "not computed", never as "settled", or a status-fetch blip would render a
      // settled-looking grid over a comparison nothing checked.
      conflictsComputed: boolean;
      loadFailures: PluginLoadFailure[];
    }
  | { ok: false; error: string };

// The host's mEdit client answers this read. Reads only — a refusal has to
// become a native notification, and only the extension host can show one.
export interface RecordPanelClient {
  // An arrow-typed property, not a method: `load` never needs its own `this`, and this shape
  // lets a test hold a bare reference to it (`vi.mocked(client.load)`) without an
  // unbound-method warning.
  load: (formKey: string) => Promise<LoadResult>;
}

export function createRecordPanelClient(): RecordPanelClient {
  return {
    async load(formKey) {
      const answer = await requestRecordLoad(formKey);
      if (!answer.ok) return { ok: false, error: answer.error };
      // Keyed by compound identity (ADR-0012), so one origin's mutability never wins for another
      // origin's plugin of the same filename.
      const pluginList = answer.plugins;
      return {
        ok: true,
        result: answer.compare && parseCompareResult(answer.compare),
        immutableSet: pluginList ? new Set(pluginList.filter(p => p.isImmutable).map(p => columnKey(p.name, p.origin))) : null,
        trackedSet: pluginList ? new Set(pluginList.filter(p => p.isTracked).map(p => columnKey(p.name, p.origin))) : null,
        conflictsComputed: answer.conflictsComputed,
        loadFailures: answer.loadFailures,
      };
    },
  };
}
