import type { ColumnKey, CompareResult } from './types';
import { columnKey } from './columnKey';
import { parseCompareResult } from './parseCompareResult';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, parseExtensionToWebview } from './messages';

// `load` asks the host for compare, plugins and status in one round trip: a compare failure fails
// the whole load, while a plugins/status failure comes back as `null` so the panel leaves that
// slice of state untouched.
export type LoadResult =
  | {
      ok: true; result: CompareResult; immutableSet: Set<ColumnKey> | null;
      // ADR-0013: mirrors immutableSet's own construction (same plugin list, same
      // columnKey() keying) — null exactly when immutableSet is (the /plugins fetch itself
      // failed), never independently.
      notInLoadOrderSet: Set<ColumnKey> | null;
      // Null exactly when immutableSet is, but degrading the opposite way: to "nothing is
      // editable", because wrongly offering an edit that cannot land is worse than wrongly
      // withholding one (ADR-0019). Read fail-closed.
      trackedSet: Set<ColumnKey> | null;
      // ADR-0013: whether the winner sweep has run. Must fail *closed* — an absent answer has to
      // read as "not computed", never as "settled", or a status-fetch blip would render a
      // settled-looking grid over a comparison nothing checked.
      conflictsComputed: boolean;
    }
  | { ok: false; error: string };

// The host's mEdit client answers this read (ADR-0002 invariant 2). Reads only — a refusal has to
// become a native notification, and only the extension host can show one.
export interface RecordPanelClient {
  // An arrow-typed property, not a method: `load` never needs its own `this`, and this shape
  // lets a test hold a bare reference to it (`vi.mocked(client.load)`) without an
  // unbound-method warning.
  load: (formKey: string) => Promise<LoadResult>;
}

let requestSeq = 0;

export function createRecordPanelClient(): RecordPanelClient {
  return {
    load(formKey) {
      const requestId = `record-load-${++requestSeq}`;
      return new Promise<LoadResult>((resolve) => {
        const handler = (event: MessageEvent) => {
          let msg;
          try {
            msg = parseExtensionToWebview(event.data);
          } catch {
            return; // Not one of ours, or a stale/mismatched build.
          }
          if (msg.type !== EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED || msg.requestId !== requestId) return;
          window.removeEventListener('message', handler);
          if (!msg.ok) { resolve({ ok: false, error: msg.error }); return; }
          // ADR-0012: keyed by compound identity — two entries sharing a filename but differing
          // in origin must stay distinct Set members, or one origin's mutability wins for both.
          const pluginList = msg.plugins;
          resolve({
            ok: true,
            result: parseCompareResult(msg.compare),
            immutableSet: pluginList ? new Set(pluginList.filter(p => p.isImmutable).map(p => columnKey(p.name, p.origin))) : null,
            notInLoadOrderSet: pluginList ? new Set(pluginList.filter(p => !p.inLoadOrder).map(p => columnKey(p.name, p.origin))) : null,
            trackedSet: pluginList ? new Set(pluginList.filter(p => p.isTracked).map(p => columnKey(p.name, p.origin))) : null,
            conflictsComputed: msg.conflictsComputed,
          });
        };
        window.addEventListener('message', handler);
        vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId, formKey });
      });
    },
  };
}
