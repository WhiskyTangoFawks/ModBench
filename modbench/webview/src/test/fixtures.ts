import { vi } from 'vitest';
import { WEBVIEW_TO_EXTENSION } from '../messages';
import type { LoadResult, RecordPanelClient } from '../RecordPanelClient';
import type { FieldDiff, FieldMetadata, PathHop, RecordEditEnvelope } from '../types';
import { columnKey } from '../columnKey';

// Nothing here imports a component: `vscode.ts` calls acquireVsCodeApi() at module load, so a
// module that reached it would throw in every test file that does not mock it.

/** A schema leaf with every required wire member at its neutral value, so no fixture can answer a
 *  question by omitting it. */
export const fieldMeta = (
  m: Partial<FieldMetadata> & Pick<FieldMetadata, 'name' | 'type'>,
): FieldMetadata => ({
  isArray: false, validFormKeyTypes: [], enumMembers: [],
  allowsNull: false, isDiscriminator: false, ...m,
});

/** A diff node with every required wire member at its neutral value. `NoConflict` paints no row
 *  background, which is what a fixture with no opinion about conflict wants. */
export const diffNode = (
  d: Partial<FieldDiff> & Pick<FieldDiff, 'fieldName'>,
): FieldDiff => ({
  values: {}, winnerColumn: '', cellStates: {}, conflictAll: 'NoConflict', ...d,
});

/** What `GET /plugins` says about one column, as far as the panel reads it. */
export interface FixturePlugin {
  name: string;
  origin?: string | null;
  isImmutable?: boolean;
  inLoadOrder?: boolean;
  isTracked?: boolean;
}

export interface PanelOpts {
  plugins?: FixturePlugin[];
  conflictsComputed?: boolean;
  /** A whole `load` of the test's own — a rejection, or one that answers differently each call. */
  load?: RecordPanelClient['load'];
}

// `compare` is a thunk so a test that edits and reloads gets the new document on the second load.
export function panelClient(compare: () => unknown, opts: PanelOpts = {}): RecordPanelClient {
  const plugins = opts.plugins ?? [];
  // ADR-0012: compound keying, so a fake keyed by bare filename cannot pass a same-filename case.
  const columnsWhere = (p: (plugin: FixturePlugin) => boolean) =>
    new Set(plugins.filter(p).map(x => columnKey(x.name, x.origin ?? null)));
  return {
    load: opts.load ?? vi.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      result: compare(),
      immutableSet: columnsWhere(p => p.isImmutable === true),
      // ADR-0013/ADR-0007: an unstated plugin is in the load order, and untracked.
      notInLoadOrderSet: columnsWhere(p => p.inLoadOrder === false),
      trackedSet: columnsWhere(p => p.isTracked === true),
      conflictsComputed: opts.conflictsComputed ?? true,
    } as unknown as LoadResult)),
  };
}

/** Every gesture posts one envelope: an operation, the hops from the record's own member down to
 *  the row, and a value where the operation takes one. */
export function postedEnvelopes(postMessage: unknown): RecordEditEnvelope[] {
  return (postMessage as ReturnType<typeof vi.fn>).mock.calls
    .filter(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD)
    .map(([m]) => (m as { envelope: RecordEditEnvelope }).envelope);
}

export const lastPostedEnvelope = (postMessage: unknown): RecordEditEnvelope | undefined =>
  postedEnvelopes(postMessage).at(-1);

/** A leaf whose `type` arrives as a plain string, the shape a schema fixture reads most naturally. */
export const leafMeta = (
  name: string, type: FieldMetadata['type'], extra: Partial<FieldMetadata> = {},
): FieldMetadata => fieldMeta({ name, type, ...extra });

export const member = (name: string): PathHop => ({ kind: 'member', name });
export const at = (index: number): PathHop => ({ kind: 'index', index });
export const keyed = (key: string): PathHop => ({ kind: 'key', key });
