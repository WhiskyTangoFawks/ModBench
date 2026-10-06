import * as vscode from 'vscode';
import {
  EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, parseWebviewToExtension,
  type ExtensionToWebview, type WebviewToExtension,
} from '../wire/messages';
import type { MEditClient, PluginLoadFailure } from '../client';
import type { Reporter } from '../ports/reporter';
import { pickRecord, type RecordPickerDeps } from './recordPicker';
import type { EditsInFlight, FollowedPanel } from './followRecord';
import type { FocusedCellContext, FocusedCells } from './focusedCells';
import { errorMessage } from '../ports/errorMessage';
import { recordTitle } from './recordTitle';

export interface RouteRecordPanelMessageDeps {
  // The FormKey picker's search and the panel's own read — one client serves both, and the
  // per-panel picker bundle below reuses it.
  meditClient: Pick<MEditClient, 'searchRecords' | 'getComparison' | 'getPlugins'>;
  channel: Pick<vscode.LogOutputChannel, 'warn'>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  // `reply` must post back to the one panel that asked, never a broadcast, so this bundle is
  // reconstructed per message at the call site rather than shared like `channel`.
  formKeyPicker: FormKeyPickerDeps | undefined;
  // The panel's own focused cell, which a field gesture from the palette acts on.
  focusCell: (context: FocusedCellContext | undefined, userFocus: boolean) => void;
  // Posts straight back to the panel that asked — REQUEST_RECORD_LOAD's own reply, built fresh
  // per panel like `formKeyPicker.reply`.
  reply: (msg: ExtensionToWebview) => void;
  // Titles the panel from the record its read answered (editor.md, Opening, story 5).
  setTitle: (title: string) => void;
  // The panel's read of `formKey` is answered, and the webview shows that record from then on.
  readAnswered: (formKey: string) => void;
  // The latest load-order status, read rather than fetched.
  conflictsComputed: () => boolean;
  loadFailures: () => readonly PluginLoadFailure[];
}

/** What every panel's messages share: the rest is the panel's own. */
export type SharedRecordPanelDeps = Omit<RouteRecordPanelMessageDeps, 'formKeyPicker' | 'focusCell' | 'reply' | 'setTitle' | 'readAnswered'>;

/** The router's bundle for one panel's messages: the picker and the record load both reply to it. */
export function routerDepsForPanel<Panel extends FollowedPanel>(
  shared: SharedRecordPanelDeps,
  panel: Panel,
  focusedCells: FocusedCells<Panel>,
  editsInFlight: Pick<EditsInFlight<Panel>, 'answered'>,
  setTitle: (title: string) => void,
): RouteRecordPanelMessageDeps {
  return {
    ...shared,
    formKeyPicker: { meditClient: shared.meditClient, reporter: shared.reporter, reply: (m) => { void panel.webview.postMessage(m); } },
    focusCell: (context, userFocus) => { focusedCells.setCell(panel, context, userFocus); },
    reply: (m) => { void panel.webview.postMessage(m); },
    setTitle,
    readAnswered: (formKey) => { editsInFlight.answered(panel, formKey); },
  };
}

export interface FormKeyPickerDeps extends RecordPickerDeps {
  reply: (msg: ExtensionToWebview) => void;
}

// One handler per webview message type, total over WEBVIEW_TO_EXTENSION: adding a message
// type is a compile error here until it names its handler — where the old dispatch chain
// silently ignored an unrouted type.
const HANDLERS: {
  [T in WebviewToExtension['type']]: (
    deps: RouteRecordPanelMessageDeps, m: Extract<WebviewToExtension, { type: T }>,
  ) => Promise<void> | void;
} = {
  [WEBVIEW_TO_EXTENSION.EDIT_FIELD]: editField,
  [WEBVIEW_TO_EXTENSION.ADD_ELEMENT]: async (_deps, m) => {
    await vscode.commands.executeCommand('modbench.record.addElement', m.context, m.value);
  },
  [WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER]: (deps, m) => replyFormKeyPicked(deps.formKeyPicker, m),
  [WEBVIEW_TO_EXTENSION.FOCUS_CELL]: (deps, m) => { deps.focusCell(m.context ?? undefined, m.entered); },
  [WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD]: answerRecordLoad,
};

// Each case below narrows `m` to its own variant, so calling its HANDLERS entry needs no
// cast — the narrowing is exactly the correlation `HANDLERS[m.type]` cannot prove on its own.
function dispatch(deps: RouteRecordPanelMessageDeps, m: WebviewToExtension): Promise<void> | void {
  switch (m.type) {
    case WEBVIEW_TO_EXTENSION.EDIT_FIELD: return HANDLERS[m.type](deps, m);
    case WEBVIEW_TO_EXTENSION.ADD_ELEMENT: return HANDLERS[m.type](deps, m);
    case WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER: return HANDLERS[m.type](deps, m);
    case WEBVIEW_TO_EXTENSION.FOCUS_CELL: return HANDLERS[m.type](deps, m);
    case WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD: return HANDLERS[m.type](deps, m);
    default: {
      const unreachable: never = m;
      return unreachable;
    }
  }
}

// The single dispatch point for every message the webview sends up. A plain function, not a
// registered-handler pattern, so a unit test can call it with only `vscode.commands
// .executeCommand` mocked.
export async function routeRecordPanelMessage(msg: unknown, deps: RouteRecordPanelMessageDeps): Promise<void> {
  let m: WebviewToExtension;
  try {
    m = parseWebviewToExtension(msg);
  } catch {
    // A message this build doesn't recognize (a stale webview build) or garbage stays a no-op.
    return;
  }
  await dispatch(deps, m);
}

async function replyFormKeyPicked(
  deps: FormKeyPickerDeps | undefined,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER }>,
): Promise<void> {
  if (!deps) return;
  const formKey = await pickRecord(deps, m.seed, m.validTypes);
  deps.reply({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: m.requestId, formKey });
}

// The grid's edit is an entry point to the command the palette fires too (commands.md, Entry points
// are not gestures).
async function editField(
  deps: RouteRecordPanelMessageDeps,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.EDIT_FIELD }>,
): Promise<void> {
  await vscode.commands.executeCommand(
    'modbench.record.editField',
    { formKey: m.formKey, plugin: m.plugin, origin: m.origin },
    m.envelope,
  );
}

// A failed comparison fails the whole load; a failed plugin list degrades to null.
async function answerRecordLoad(
  deps: RouteRecordPanelMessageDeps,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD }>,
): Promise<void> {
  const [compare, plugins] = await Promise.allSettled([
    deps.meditClient.getComparison(m.formKey),
    deps.meditClient.getPlugins(),
  ]);
  if (compare.status === 'rejected') {
    deps.channel.warn(`Failed to read ${m.formKey}: ${errorMessage(compare.reason)}`);
    deps.reply({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: m.requestId,
      ok: false, error: errorMessage(compare.reason),
    });
    return;
  }
  deps.setTitle(recordTitle(m.formKey, compare.value?.overrides));
  deps.readAnswered(m.formKey);
  deps.reply({
    type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: m.requestId, ok: true,
    compare: compare.value, plugins: plugins.status === 'fulfilled' ? plugins.value : null,
    conflictsComputed: deps.conflictsComputed(), loadFailures: [...deps.loadFailures()],
  });
}
