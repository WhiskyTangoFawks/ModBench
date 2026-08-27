import * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './messages';
import type { Reporter } from '../modmanager/deployer';
import type { RecordSummary } from './ApiClient';
import type { PluginRepository } from './PluginRepository';
import { openExtendedFieldEditor, type ExtendedFieldEditorDeps } from './extendedFieldEditor';

export interface RouteRecordPanelMessageDeps {
  // #415/ADR-0041: the single write path, reached from the panel. Injected rather than imported so
  // this stays callable from a plain unit test — the same reason every other dep here is.
  // #426: also the FormKey picker's own search — the one `repository` field the real caller
  // passes the full PluginRepository into, so the per-panel formKeyPicker bundle below reuses it
  // rather than threading a second repository reference through OpenRecordPanelDeps.
  // #426 Track 5: also the condition-function picker's own catalogue fetch — same reasoning.
  repository: Pick<PluginRepository, 'editRecordField' | 'searchRecords' | 'getConditionFunctions'>;
  // #415: how the panel learns to re-read once an edit has landed. A plain callback rather than a
  // webview handle, so this router never has to know which panel asked.
  // #428: plugin/origin ride along too — EDIT_FIELD already carries both (the edit's own
  // identity), and the tree-decoration wiring needs them to patch the one cached record the edit
  // touched (PluginTreeProvider.markWorkingTreeState) without re-deriving them from formKey alone
  // (a FormKey names a record, not which plugin's copy of it this edit landed on).
  onRecordEdited: (formKey: string, plugin: string, origin: string) => void;
  // #200: the leveled 'Modbench' channel (#198) the webview has no direct route to — the
  // webview composes the full message text (it has the plugin/field/record identity), this is
  // a pure level→method forward, no VS Code types beyond the injected Pick.
  channel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
  // Issue #224: ADR-0026 surfacing for COPY_TO_CLIPBOARD's failure path — a rejected
  // `vscode.env.clipboard.writeText` (headless/remote sessions, missing Linux clipboard tooling,
  // Wayland permissions) is an "explicit action failed" per the severity table (the user pressed
  // Ctrl+C), so it needs an error notification + log, not a silent swallow.
  reporter: Reporter;
  // Issue #210 (#426: restored): `reply` must post back to the one panel that asked (never a
  // broadcast — see messages.ts' FORM_KEY_PICKED doc comment), so this whole bundle is
  // reconstructed per message at the onDidReceiveMessage call site rather than shared like
  // `channel`/`reporter`. Undefined when the panel wasn't wired for the picker, matching every
  // other optional bundle's convention pre-#410.
  formKeyPicker: FormKeyPickerDeps | undefined;
  // Issue #211 (#426 Track 5: restored): same per-panel reconstruction as formKeyPicker above, for
  // the same reason — the reply must go back to the one panel that asked.
  conditionFunctionPicker: ConditionFunctionPickerDeps | undefined;
  // Issue #230 (#426: restored): same per-panel reconstruction as formKeyPicker above (`reply`
  // must go back to the one panel that asked) — but this bundle also carries `tempRoot`/`log`,
  // which are session-static and simply copied into every per-panel reconstruction rather than
  // varying with it (see extendedFieldEditor.ts's own doc comment for why a real temp file is
  // the vehicle).
  extendedFieldEditor: ExtendedFieldEditorDeps | undefined;
}

export interface FormKeyPickerDeps {
  repository: Pick<PluginRepository, 'searchRecords'>;
  reply: (msg: ExtensionToWebview) => void;
}

export interface ConditionFunctionPickerDeps {
  repository: Pick<PluginRepository, 'getConditionFunctions'>;
  reply: (msg: ExtensionToWebview) => void;
}

// Issue #224: Ctrl+C's clipboard write. `vscode.env.clipboard.writeText` is extension-host-only
// (webview clipboard access isn't guaranteed) — the webview has already computed the model value
// (modelValue.ts) by the time this arrives, so there's nothing to inject; this is a direct call,
// same as OPEN_RECORD's `vscode.commands.executeCommand` in routeRecordPanelMessage below, not
// routed through a deps bundle like the *Picker/*Confirm/*Name bridges (which need a per-panel
// reply target this fire-and-forget message has no use for). Split out of
// routeRecordPanelMessage's own dispatch (like routePromptMessage above) partly to keep that
// function's complexity down, and partly because the try/catch reads better as its own named
// step: this message is itself called fire-and-forget (`void routeRecordPanelMessage(...)` at the
// onDidReceiveMessage call site), so an unhandled rejection here would surface as nothing at all,
// not even a silent swallow — a real failure mode for a clipboard write (headless/remote sessions,
// missing Linux clipboard tooling, Wayland permissions), so it gets the same catch-log-surface
// treatment every other catch in this codebase uses (modbench/CLAUDE.md: "no silent catch {}").
async function copyToClipboard(reporter: Reporter, value: string): Promise<void> {
  try {
    await vscode.env.clipboard.writeText(value);
  } catch (err) {
    reporter.report('error', 'Could not copy to the clipboard.', err instanceof Error ? err.message : String(err));
  }
}

// Issue #174: the record editor webview and the extension host are different processes,
// bridged only by `postMessage` — this is the single dispatch point for every message the
// webview sends up. Kept as a plain function (not a class/registered-handler pattern) so it's
// callable directly from a unit test without a VS Code test harness: only `vscode.commands
// .executeCommand` needs mocking, everything else is a plain-object dep.
export async function routeRecordPanelMessage(msg: unknown, deps: RouteRecordPanelMessageDeps): Promise<void> {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return;
  const m = msg as WebviewToExtension;
  if (m.type === WEBVIEW_TO_EXTENSION.OPEN_RECORD) {
    await vscode.commands.executeCommand('modbench.openEditor', { formKey: m.formKey, label: m.formKey });
  } else if (m.type === WEBVIEW_TO_EXTENSION.LOG) {
    deps.channel[m.level](m.message);
  } else if (m.type === WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD) {
    await copyToClipboard(deps.reporter, m.value);
  } else {
    await routeWritePathMessage(deps, m);
  }
}

// Split out of routeRecordPanelMessage above purely to keep that function's own branch count from
// growing every time this ticket's write path (EDIT_FIELD, the *Picker bridges, the extended
// editor) gains another message type — a line-count concern (ESLint's complexity budget), not a
// behavioral one; every message here still reaches exactly the same handler it would inline.
async function routeWritePathMessage(deps: RouteRecordPanelMessageDeps, m: WebviewToExtension): Promise<void> {
  if (m.type === WEBVIEW_TO_EXTENSION.EDIT_FIELD) {
    await editField(deps, m);
  } else if (m.type === WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER || m.type === WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER) {
    await routePickerMessage(deps, m);
  } else if (m.type === WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR) {
    await openExtendedEditor(deps.extendedFieldEditor, m);
  }
}

// Issue #211/#212 (#426: restored): split out of routeRecordPanelMessage's own dispatch, matching
// the pre-#410 shape, purely to keep that function's own branch count from growing every time
// another *Picker bridge is added — this file's own two QuickPick pickers share nothing beyond
// "resolve a value natively, then reply," so grouping them here rather than inlining two more
// `else if` branches is a line-count concern, not a behavioral one.
async function routePickerMessage(
  deps: RouteRecordPanelMessageDeps,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER | typeof WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER }>,
): Promise<void> {
  if (m.type === WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER) {
    await replyFormKeyPicked(deps.formKeyPicker, m);
  } else {
    await replyConditionFunctionPicked(deps.conditionFunctionPicker, m);
  }
}

// Issue #230 (#426: restored): the extension host's own half of the extended-editor bridge — the
// deps-present guard matches every other optional bundle's convention, and the real work
// (temp file, tab, save/close listeners) lives entirely in extendedFieldEditor.ts, which owns its
// reply(ies) itself (zero, one, or many — a save event per Ctrl+S, plus one on close), so this is
// a thin pass-through rather than a reply-once wrapper.
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

// Issue #210 (#426: restored): same "EditorID [FormKey]" label the picker's items have always
// rendered — the same composite FormKeyLink/FormKeyCell use to display a resolved reference, so
// what a reference is *chosen* in and what it is *read back* in are identical (#218).
function toFormKeyQuickPickItem(r: RecordSummary): vscode.QuickPickItem & { formKey: string } {
  return { label: r.editorId ? `${r.editorId} [${r.formKey}]` : r.formKey, formKey: r.formKey };
}

// Issue #218: since FormKey cells display the same "EditorID [FormKey]" composite these items do,
// a user can copy a cell and paste the whole label into another FormKey cell's picker — where
// searching for the literal would find nothing. A bracketed query is searched on the bracket's
// contents; anything else is searched as typed, so bare EditorIDs and bare FormKeys behave exactly
// as they did before (#210).
//
// The *first* bracketed segment wins, not the last: a VMAD object reference reads
// "SomeNPC [000123:Foo.esp] [2]", where the trailing bracket is the alias index, not the identity.
// And when the label and the FormKey disagree — a stale copy, a hand-edited string — the FormKey
// is what resolves, because it is the identity and the EditorID is decoration.
//
// An empty or whitespace-only capture falls back to the query as typed rather than to '': the
// caller treats an empty query as "clear the list", which would read as "no matches" for something
// the user did type.
export function normalizeFormKeyQuery(query: string): string {
  const bracketed = /\[([^\]]*)\]/.exec(query)?.[1]?.trim();
  return bracketed || query;
}

// Issue #210 (#426: restored): the FormKey picker as a native QuickPick — the extension-host half
// of the bridge (pickFormKey on the webview side posts OPEN_FORM_KEY_PICKER and awaits the reply
// this produces). Seeded with `seed` (the current reference, or '' when adding a brand-new
// property) so the reference is visible instead of an empty-query default; an immediate search on
// the seed pre-selects the matching item (setting `.value` doesn't fire onDidChangeValue on its
// own — QuickPick has no InputBox-style `valueSelection` to also highlight the *text*, so
// "pre-selected" here means the seeded item is active/highlighted in the results list). Typing
// re-searches on the same 200ms debounce and `validTypes` filter as before; a stale in-flight
// search is dropped via a sequence guard, never allowed to clobber a newer one. Resolves to the
// picked FormKey, or null on Escape/blur (no selection) — the caller leaves its field unchanged.
//
// Issue #218: every query — seeded or typed — goes through normalizeFormKeyQuery first, so a whole
// "EditorID [FormKey]" label pasted from a cell searches on the reference it names. This is also
// what makes paste into a FormKey cell need nothing built: the QuickPick is a native input, so
// Ctrl+V already works, and the autocomplete is what makes it safe — a pasted reference is not
// committed until it has resolved to a real record in the list.
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
      // Issue #218: normalized, because the seed is the composite the cell displays — comparing
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

// Issue #211: extracted so routeRecordPanelMessage's own branch stays a single statement, matching
// the shape of every other branch there — the "deps present?" guard (a no-op when this panel
// wasn't wired for the picker) and the QuickPick-then-reply sequence both live here instead of
// inline.
async function replyFormKeyPicked(
  deps: FormKeyPickerDeps | undefined,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER }>,
): Promise<void> {
  if (!deps) return;
  const formKey = await pickFormKeyViaQuickPick(deps, m.seed, m.validTypes);
  deps.reply({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: m.requestId, formKey });
}

// Issue #211 (#426 Track 5: restored): the condition-function picker as a native QuickPick —
// simpler than pickFormKeyViaQuickPick above (the webview cannot call vscode.window.showQuickPick
// itself either), since the function catalogue is bounded/game-scoped and fetched once rather than
// driven through createQuickPick's per-keystroke search. "Seeded with the current value" is
// satisfied by sorting the seed to the front of the array passed to showQuickPick — that API has
// no activeItem/activeItems option (only createQuickPick does), so array order is the only way to
// pre-highlight an item, and VS Code focuses the first item by default. A seed absent from the
// catalogue (or empty, e.g. a function-less value) leaves the array unreordered. Resolves to the
// picked function name, or null when dismissed without a selection — the caller leaves the
// condition unchanged, same convention as pickFormKeyViaQuickPick.
export async function pickConditionFunctionViaQuickPick(
  deps: ConditionFunctionPickerDeps, seed: string,
): Promise<string | null> {
  const all = await deps.repository.getConditionFunctions();
  const items = seed && all.includes(seed) ? [seed, ...all.filter(f => f !== seed)] : all;
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a condition function…' });
  return picked ?? null;
}

// Issue #211: same shape as replyFormKeyPicked above, for the condition-function QuickPick.
async function replyConditionFunctionPicked(
  deps: ConditionFunctionPickerDeps | undefined,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER }>,
): Promise<void> {
  if (!deps) return;
  const functionName = await pickConditionFunctionViaQuickPick(deps, m.seed);
  deps.reply({ type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId: m.requestId, functionName });
}

// Issue #231 (#426 Track 5: restored): Add Script's own native input box — unlike the two pickers
// above, this needs no reply bridge back to the webview at all: modbench.vmad.addScript
// (extension.ts) calls it directly and broadcasts VMAD_STRUCTURAL_OP itself once a name comes
// back, the same "no round trip" shape Set Script/Property Flags' own showQuickPick calls use.
// Exported (not module-private) purely so extension.ts's command handler can call it — this file
// is where every other native-prompt bridge already lives.
export async function pickScriptNameViaInputBox(): Promise<string | null> {
  const name = await vscode.window.showInputBox({
    prompt: 'Script name',
    validateInput: v => (v.trim() === '' ? 'Name is required' : null),
  });
  return name ?? null;
}

/**
 * #415/ADR-0041: one field edit, and the surfacing of whatever came back.
 *
 * This is the reason an edit travels through the extension host at all rather than going straight
 * from the webview to the backend the way every read does: a refusal has to become something the
 * user can act on, and a native notification is a surface only the host has. The refusal message is
 * the backend's own — it already names the way out (Track this mod, or author a patch plugin), and
 * re-wording it here would put that text in two places with only one of them tested.
 *
 * "The plugin cannot be edited" is a warning, not an error: the user asked for something reasonable
 * and got a clear answer with a next step. A transport failure is an error — nothing answered
 * (ADR-0026's severity table).
 */
async function editField(
  deps: RouteRecordPanelMessageDeps,
  m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.EDIT_FIELD }>,
): Promise<void> {
  try {
    const outcome = await deps.repository.editRecordField(m.formKey, m.plugin, m.origin, m.fieldPath, m.value);
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
