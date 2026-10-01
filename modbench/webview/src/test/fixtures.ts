import { vi } from 'vitest';
import { act } from '@testing-library/react';
import { WEBVIEW_TO_EXTENSION, hasSection, type ExtensionToWebview, type WebviewToExtension } from '../messages';
import type { RecordPanelClient } from '../RecordPanelClient';
import type { CompareOverride, CompareResult, FieldDiff, FieldMetadata, PathHop, PluginLoadFailure, RecordEditEnvelope } from '../types';
import { columnKey } from '../columnKey';

// Nothing here imports a component: `vscode.ts` calls acquireVsCodeApi() at module load, so a
// module that reached it would throw in every test file that does not mock it.

/** A schema leaf with every required wire member at its neutral value, so no fixture can answer a
 *  question by omitting it. */
export const fieldMeta = (
  m: Partial<FieldMetadata> & Pick<FieldMetadata, 'name' | 'type'>,
): FieldMetadata => ({
  isArray: false, validFormKeyTypes: [], enumMembers: [],
  allowsNull: false, isDiscriminator: false, isRecordHeaderMember: false, ...m,
});

/** A diff node with every required wire member at its neutral value. `NoConflict` paints no row
 *  background, which is what a fixture with no opinion about conflict wants. */
export const diffNode = (
  d: Partial<FieldDiff> & Pick<FieldDiff, 'fieldName'>,
): FieldDiff => ({
  values: {}, winnerColumn: '', cellStates: {}, conflictAll: 'NoConflict', ...d,
});

/** A compare override with every required wire member at its neutral value: `OnlyOne` is the
 *  unconflicted ConflictThis, and `Data` is columnKey()'s own elided origin. */
export const compareOverride = (
  o: Partial<CompareOverride> & Pick<CompareOverride, 'formKey' | 'plugin' | 'fields'>,
): CompareOverride => ({
  loadIndex: '00', isWinner: false, origin: 'Data', recordType: '',
  isPartialForm: false, conflictThis: 'OnlyOne', isInOverwrite: false, ...o,
});

/** A compare result with every required wire member at its neutral value, so a fixture answers
 *  no wire question by omission — the same posture as fieldMeta/diffNode/compareOverride. */
export const compareResultFixture = (over: Partial<CompareResult> = {}): CompareResult => ({
  overrides: [], diffs: [], conflictAll: 'NoConflict', recordTypeName: 'Non-Player Character', ...over,
});

/** What `GET /plugins` says about one column, as far as the panel reads it. */
export interface FixturePlugin {
  name: string;
  origin?: string | null;
  isImmutable?: boolean;
  isTracked?: boolean;
}

export interface PanelOpts {
  plugins?: FixturePlugin[];
  conflictsComputed?: boolean;
  loadFailures?: PluginLoadFailure[];
  /** A whole `load` of the test's own — a rejection, or one that answers differently each call. */
  load?: RecordPanelClient['load'];
}

// `compare` is a thunk so a test that edits and reloads gets the new document on the second load;
// its result is a real CompareResult, not a freehand value cast at the boundary.
export function panelClient(compare: () => CompareResult, opts: PanelOpts = {}): RecordPanelClient {
  const plugins = opts.plugins ?? [];
  // ADR-0012: compound keying, so a fake keyed by bare filename cannot pass a same-filename case.
  const columnsWhere = (p: (plugin: FixturePlugin) => boolean) =>
    new Set(plugins.filter(p).map(x => columnKey(x.name, x.origin ?? null)));
  return {
    load: opts.load ?? vi.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      // A fresh clone per load(): a fixture is one shared module-level object, and a test that
      // edits and reloads must not hand the panel the same reference twice.
      result: structuredClone(compare()),
      immutableSet: columnsWhere(p => p.isImmutable === true),
      // ADR-0007: an unstated plugin is untracked.
      trackedSet: columnsWhere(p => p.isTracked === true),
      conflictsComputed: opts.conflictsComputed ?? true,
      loadFailures: opts.loadFailures ?? [],
    })),
  };
}

/** Every gesture posts one envelope: an operation, the hops from the record's own member down to
 *  the row, and a value where the operation takes one. */
export function postedEnvelopes(postMessage: (msg: WebviewToExtension) => void): RecordEditEnvelope[] {
  return vi.mocked(postMessage).mock.calls
    .map(([m]) => m)
    .filter((m): m is Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.EDIT_FIELD }> =>
      m.type === WEBVIEW_TO_EXTENSION.EDIT_FIELD)
    .map((m) => m.envelope);
}

/** What the focused cell last told the host: the Arguments its keys' commands act on. */
export function lastToldCell(postMessage: (msg: WebviewToExtension) => void): Record<string, unknown> | undefined {
  return vi.mocked(postMessage).mock.calls
    .flatMap(([m]) => (m.type === WEBVIEW_TO_EXTENSION.FOCUS_CELL && m.context ? [m.context] : []))
    .at(-1);
}

/** The focused cell last told the host when it is an element: what Delete and Alt+Up and Alt+Down
 *  act on. */
export function lastToldElement(postMessage: (msg: WebviewToExtension) => void): Record<string, unknown> | undefined {
  const cell = lastToldCell(postMessage);
  return hasSection(cell, 'arrayElement') ? cell : undefined;
}

/** A drop on an array posts the add element it fires and the array it names. */
export function lastAddElement(postMessage: (msg: WebviewToExtension) => void) {
  return vi.mocked(postMessage).mock.calls
    .map(([m]) => m)
    .filter((m): m is Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.ADD_ELEMENT }> =>
      m.type === WEBVIEW_TO_EXTENSION.ADD_ELEMENT)
    .at(-1);
}

/** The host posting `message` to the panel. */
export function tellPanel(message: ExtensionToWebview): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: message })); });
}

export const lastPostedEnvelope = (
  postMessage: (msg: WebviewToExtension) => void,
): RecordEditEnvelope | undefined => postedEnvelopes(postMessage).at(-1);

/** A leaf whose `type` arrives as a plain string, the shape a schema fixture reads most naturally. */
export const leafMeta = (
  name: string, type: FieldMetadata['type'], extra: Partial<FieldMetadata> = {},
): FieldMetadata => fieldMeta({ name, type, ...extra });

export const member = (name: string): PathHop => ({ kind: 'member', name });
export const at = (index: number): PathHop => ({ kind: 'index', index });

// A miss here is a fixture bug, named at the point it would otherwise become a bare TypeError.
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A `data-vscode-context` blob's one parse point: proves it is a JSON object before a test
 *  reads a member off it, without claiming a type for that member beyond `unknown`. */
export function parseJsonRecord(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error('expected a JSON object');
  return parsed;
}
