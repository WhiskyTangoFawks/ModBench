import * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './messages';
import type { Reporter } from '../modmanager/deployer';
import type { RecordSummary } from './ApiClient';
import type { PluginRepository } from './PluginRepository';
import { openExtendedFieldEditor, type ExtendedFieldEditorDeps } from './extendedFieldEditor';

export interface RouteRecordPanelMessageDeps {
  // ADR-0041: the single write path, reached from the panel. Injected rather than imported so this
  // stays callable from a plain unit test. Also the FormKey picker's own search, reused by the
  // per-panel bundle below.
  repository: Pick<PluginRepository, 'editRecordField' | 'searchRecords'>;
  // A plain callback rather than a webview handle, so this router never has to know which panel
  // asked. plugin/origin ride along because a FormKey names a record, not which plugin's copy of
  // it this edit landed on.
  onRecordEdited: (formKey: string, plugin: string, origin: string) => void;
  // The leveled 'Modbench' channel the webview has no direct route to — the webview composes the
  // message text, this is a pure level→method forward.
  channel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
  // A rejected clipboard write (headless windows, missing Linux clipboard tooling, Wayland
  // permissions) is "explicit action failed" per ADR-0026 — the user pressed Ctrl+C — so it needs
  // a notification, not a silent swallow.
  reporter: Reporter;
  // `reply` must post back to the one panel that asked, never a broadcast, so this bundle is
  // reconstructed per message at the call site rather than shared like `channel`/`reporter`.
  formKeyPicker: FormKeyPickerDeps | undefined;
  // Same per-panel reconstruction as formKeyPicker above, but this bundle also carries
  // `tempRoot`/`log`, which are load-order-static and copied into every reconstruction.
  extendedFieldEditor: ExtendedFieldEditorDeps | undefined;
}

export interface FormKeyPickerDeps {
  repository: Pick<PluginRepository, 'searchRecords'>;
  reply: (msg: ExtensionToWebview) => void;
}

// `vscode.env.clipboard.writeText` is extension-host-only, so this is a direct call rather than an
// injected dep. Its own function because the message is dispatched fire-and-forget, so an
// unhandled rejection would surface as nothing.
async function copyToClipboard(reporter: Reporter, value: string): Promise<void> {
  try {
    await vscode.env.clipboard.writeText(value);
  } catch (err) {
    reporter.report('error', 'Could not copy to the clipboard.', err instanceof Error ? err.message : String(err));
  }
}

// One handler per webview message type, total over WEBVIEW_TO_EXTENSION: adding a message
// type is a compile error here until it names its handler — where the old dispatch chain
// silently ignored an unrouted type.
const HANDLERS: {
  [T in WebviewToExtension['type']]: (
    deps: RouteRecordPanelMessageDeps, m: Extract<WebviewToExtension, { type: T }>,
  ) => Promise<void> | void;
} = {
  [WEBVIEW_TO_EXTENSION.OPEN_RECORD]: async (_deps, m) => {
    await vscode.commands.executeCommand('modbench.openEditor', { formKey: m.formKey, label: m.formKey });
  },
  [WEBVIEW_TO_EXTENSION.LOG]: (deps, m) => { deps.channel[m.level](m.message); },
  [WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD]: (deps, m) => copyToClipboard(deps.reporter, m.value),
  [WEBVIEW_TO_EXTENSION.EDIT_FIELD]: editField,
  [WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER]: (deps, m) => replyFormKeyPicked(deps.formKeyPicker, m),
  [WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR]: (deps, m) => openExtendedEditor(deps.extendedFieldEditor, m),
};

// The single dispatch point for every message the webview sends up. A plain function, not a
// registered-handler pattern, so a unit test can call it with only `vscode.commands
// .executeCommand` mocked.
export async function routeRecordPanelMessage(msg: unknown, deps: RouteRecordPanelMessageDeps): Promise<void> {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return;
  const m = msg as WebviewToExtension;
  const handler = HANDLERS[m.type] as
    | ((deps: RouteRecordPanelMessageDeps, m: WebviewToExtension) => Promise<void> | void)
    | undefined;
  // A message whose type the map doesn't know (a stale webview build) stays a no-op.
  if (handler) await handler(deps, m);
}

// The real work lives in extendedFieldEditor.ts, which owns its replies itself (zero, one, or
// many), so this is a thin pass-through rather than a reply-once wrapper.
async function openExtendedEditor(
  deps: ExtendedFieldEditorDeps | undefined,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR }>,
): Promise<void> {
  if (!deps) return;
  await openExtendedFieldEditor(
    {
      requestId: m.requestId, value: m.value, recordLabel: m.recordLabel, fieldName: m.fieldName,
      plugin: m.plugin, origin: m.origin, readOnly: m.readOnly,
    },
    deps,
  );
}

// The same "EditorID [FormKey]" label the picker's items have always
// rendered — the same composite FormKeyLink/FormKeyCell use to display a resolved reference, so
// what a reference is *chosen* in and what it is *read back* in are identical.
function toFormKeyQuickPickItem(r: RecordSummary): vscode.QuickPickItem & { formKey: string } {
  return { label: r.editorId ? `${r.editorId} [${r.formKey}]` : r.formKey, formKey: r.formKey };
}

// A user can paste a whole "EditorID [FormKey]" label into a picker, where searching the literal
// would find nothing. The *first* bracketed segment wins: a VMAD object reference's trailing
// bracket is an alias index, not identity.
export function normalizeFormKeyQuery(query: string): string {
  const bracketed = /\[([^\]]*)\]/.exec(query)?.[1]?.trim();
  return bracketed || query;
}

// Seeded with the current reference so it is visible instead of an empty-query default; setting
// `.value` does not fire onDidChangeValue, so the seed is searched explicitly. A stale in-flight
// search is dropped by a sequence guard.
export async function pickFormKeyViaQuickPick(
  deps: FormKeyPickerDeps, seed: string, validTypes: string[],
): Promise<string | null> {
  const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { formKey: string }>();
  quickPick.placeholder = 'Search EditorID or FormKey…';
  quickPick.value = seed;

  let seq = 0;
  const runSearch = async (query: string) => {
    const mySeq = ++seq;
    if (!query.trim()) { quickPick.items = []; return; }
    quickPick.busy = true;
    try {
      const { items } = await deps.repository.searchRecords(normalizeFormKeyQuery(query), validTypes);
      if (mySeq !== seq) return;
      const qpItems = items.map(toFormKeyQuickPickItem);
      quickPick.items = qpItems;
      // Normalized, because the seed is the composite the cell displays — comparing
      // the raw seed against a bare formKey would match only when the reference is unresolved.
      const seeded = qpItems.find(i => i.formKey === normalizeFormKeyQuery(seed));
      if (seeded) quickPick.activeItems = [seeded];
    } finally {
      if (mySeq === seq) quickPick.busy = false;
    }
  };

  void runSearch(seed);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  quickPick.onDidChangeValue(value => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!value.trim()) { quickPick.items = []; seq++; return; }
    debounceTimer = setTimeout(() => void runSearch(value), 200);
  });

  return new Promise<string | null>(resolve => {
    let accepted = false;
    quickPick.onDidAccept(() => {
      accepted = true;
      quickPick.hide();
      resolve(quickPick.selectedItems[0]?.formKey ?? null);
    });
    quickPick.onDidHide(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      quickPick.dispose();
      if (!accepted) resolve(null);
    });
    quickPick.show();
  });
}

async function replyFormKeyPicked(
  deps: FormKeyPickerDeps | undefined,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER }>,
): Promise<void> {
  if (!deps) return;
  const formKey = await pickFormKeyViaQuickPick(deps, m.seed, m.validTypes);
  deps.reply({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: m.requestId, formKey });
}

// An edit travels through the extension host rather than straight to the backend because a
// refusal has to become a native notification, a surface only the host has. A refusal is a
// warning, a transport failure an error.
async function editField(
  deps: RouteRecordPanelMessageDeps,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.EDIT_FIELD }>,
): Promise<void> {
  try {
    // The webview still posts one member and its value; the host spells that as the one write
    // shape the backend takes, until the webview posts the envelope itself.
    const outcome = await deps.repository.editRecordField(m.formKey, m.plugin, m.origin, {
      op: 'set', path: [{ kind: 'member', name: m.fieldPath }], value: m.value,
    });
    if (outcome.applied) {
      deps.onRecordEdited(m.formKey, m.plugin, m.origin);
      return;
    }
    deps.reporter.report('warning', outcome.message);
  } catch (err) {
    deps.reporter.report(
      'error', 'Could not edit this record.', err instanceof Error ? err.message : String(err));
  }
}
