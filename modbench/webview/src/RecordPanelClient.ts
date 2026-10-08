import type { ColumnKey, CompareResult, PluginLoadFailure } from './types';
import { columnKey, copyColumnKey } from '../../src/wire/columnKey';
import { pluginAddressOf, samePluginAddress } from '../../src/wire/pluginAddress';
import { parseCompareResult } from './parseCompareResult';
import { requestRecordLoad } from './nativeBridge';
import { tabState } from './vscode';
import { isColumnCopies, type ColumnCopy, type ModRepository } from '../../src/wire/messages';

// `load` asks the host for compare, plugins and status in one round trip: a compare failure fails
// the whole load, while a plugins/status failure comes back as `null` so the panel leaves that
// slice of state untouched.
type LoadResult =
  | (LoadedPanel & PanelRead)
  | { ok: false; error: string };

// Null is records held by no plugin at all, which `gone` names (editor.md, States, story 4).
type PanelRead =
  | { result: CompareResult }
  | { result: null; gone: string[]; copiesLacking: string[] };

interface LoadedPanel {
  ok: true; immutableSet: Set<ColumnKey> | null;
  // Null exactly when immutableSet is, but degrading the opposite way: to "nothing is
  // editable" (commands.md, No dead entries). Read fail-closed.
  trackedSet: Set<ColumnKey> | null;
  sourceUnreadableSet: Set<ColumnKey> | null;
  // The repository state of each origin that names a mod, which a column header offers track or decompile on.
  modsByOrigin: Record<string, ModRepository>;
  // Whether the winner sweep has run (editor.md, States, story 3). Fails *closed*: an absent
  // answer reads as "not computed", never as "settled", or a status-fetch blip would render a
  // settled-looking grid over a comparison nothing checked.
  conflictsComputed: boolean;
  loadFailures: PluginLoadFailure[];
  // The column of the copy the tab's document holds; undefined when the read holds no such copy.
  fileColumn: ColumnKey | undefined;
  // The file's copy is read with no other (editor.md, States, story 7).
  alone: boolean;
}

// The host's mEdit client answers this read. Reads only — a refusal has to
// become a native notification, and only the extension host can show one.
export interface RecordPanelClient {
  // An arrow-typed property, not a method: `load` never needs its own `this`, and this shape
  // lets a test hold a bare reference to it (`vi.mocked(client.load)`) without an
  // unbound-method warning.
  load: (formKey: string) => Promise<LoadResult>;
  showColumns: (columns: ColumnCopy[]) => void;
}

const mEditWindow = window as Window & typeof globalThis & { mEditColumns?: unknown };

// The columns are kept with the tab, so they outlive a reload.
function keptColumns(): ColumnCopy[] | undefined {
  const state = tabState.getState();
  const kept = typeof state === 'object' && state !== null && 'columns' in state ? state.columns : undefined;
  return isColumnCopies(kept) ? kept : undefined;
}

const keepColumns = (columns: ColumnCopy[]): void => { tabState.setState({ columns }); };

export function createRecordPanelClient(): RecordPanelClient {
  // The page states the columns only when the tab is new.
  if (!keptColumns()) keepColumns(isColumnCopies(mEditWindow.mEditColumns) ? mEditWindow.mEditColumns : []);
  return {
    showColumns: keepColumns,
    async load(formKey) {
      const answer = await requestRecordLoad(formKey, keptColumns() ?? []);
      if (!answer.ok) return { ok: false, error: answer.error };
      // Keyed by compound identity (ADR-0012), so one origin's mutability never wins for another
      // origin's plugin of the same filename.
      const pluginList = answer.plugins;
      const read: PanelRead = answer.compare === null
        ? { result: null, gone: answer.gone, copiesLacking: answer.copiesLacking }
        : { result: parseCompareResult(answer.compare) };
      const result = read.result;
      // Several records compared put the document's copy first, so the first match is it.
      const fileCopy = result?.overrides.find(o =>
        o.formKey === formKey && samePluginAddress(pluginAddressOf(o), answer.documentPlugin));
      return {
        ok: true,
        ...read,
        immutableSet: pluginList ? new Set(pluginList.filter(p => p.isImmutable).map(p => columnKey(p))) : null,
        trackedSet: pluginList ? new Set(pluginList.filter(p => p.isTracked).map(p => columnKey(p))) : null,
        sourceUnreadableSet: pluginList ? new Set(pluginList.filter(p => p.pluginSourceUnreadable).map(p => columnKey(p))) : null,
        modsByOrigin: answer.modsByOrigin,
        conflictsComputed: answer.conflictsComputed,
        loadFailures: answer.loadFailures,
        fileColumn: fileCopy && copyColumnKey(fileCopy),
        alone: answer.alone,
      };
    },
  };
}
