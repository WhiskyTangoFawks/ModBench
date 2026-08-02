import * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './messages';
import type { PendingChangesTreeProvider, PendingTreeNode } from './PendingChangesTreeProvider';
import type { Reporter } from '../modmanager/deployer';
import type { RecordSummary } from './ApiClient';
import type { PluginRepository } from './PluginRepository';

// Issue #140: reveal deps bundled into one optional param so a record panel not wired for
// reveal (there is exactly one, but keeping the seam explicit) still compiles — and so
// openRecordPanel's own parameter count doesn't grow every time the panel needs one more
// thing from the extension host.
export interface RevealDeps {
  provider: PendingChangesTreeProvider;
  view: vscode.TreeView<PendingTreeNode>;
  log: (msg: string) => void;
  reporter: Reporter;
}

// Issue #140/#208: resolves a pending change id to a tree node and reveals it, expanding a
// multi-member group's parent and showing the tree if it was collapsed or not visible
// (`focus: true`). No record semantics live here — resolution is the provider's job
// (`resolveChange`), this is purely the VS Code plumbing the webview can't do itself. A
// change that is no longer pending (already saved or reverted) resolves to `undefined` and
// is logged, not thrown (ADR-0026-style: recoverable, not a toast). Exported: issue #208's
// native `modbench.pendingCell.reveal` command calls this directly (the work is entirely
// extension-host-side — TreeProvider/TreeView — so unlike Save Group/Revert Group it never
// needs to round-trip through the webview).
export async function revealPendingChange(changeId: string, deps: RevealDeps | undefined): Promise<void> {
  if (!deps) return;
  try {
    const node = await deps.provider.resolveChange(changeId);
    if (!node) {
      deps.log(`[revealPendingChange] change ${changeId} is no longer pending (saved or reverted)`);
      return;
    }
    await deps.view.reveal(node, { select: true, focus: true, expand: true });
  } catch (err) {
    // An explicit user action failed (they clicked the cell), so ADR-0026 wants a notification,
    // not a silent log — unlike the no-longer-pending branch above, which is recoverable.
    deps.reporter.report('error', 'Could not reveal that pending change.', err instanceof Error ? err.message : String(err));
  }
}

export interface RouteRecordPanelMessageDeps {
  reveal: RevealDeps | undefined;
  // #200: the leveled 'Modbench' channel (#198) the webview has no direct route to — the
  // webview composes the full message text (it has the plugin/field/record identity), this is
  // a pure level→method forward, no VS Code types beyond the injected Pick.
  channel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
  // Issue #210: bundled like RevealDeps above — `reply` is rebuilt per panel at the
  // onDidReceiveMessage call site (it must post back to the one panel that asked, never a
  // broadcast — see messages.ts' FORM_KEY_PICKED doc comment), so this whole bundle is
  // reconstructed per message rather than shared like `reveal`/`channel`.
  formKeyPicker: FormKeyPickerDeps | undefined;
  // Issue #211: same per-message reconstruction as formKeyPicker above, for the same reason —
  // the reply must go back to the one panel that asked.
  conditionFunctionPicker: ConditionFunctionPickerDeps | undefined;
  // Issue #212: same per-message reconstruction as formKeyPicker/conditionFunctionPicker above.
  revertGroupConfirm: RevertGroupConfirmDeps | undefined;
  addScriptName: AddScriptNameDeps | undefined;
}

export interface FormKeyPickerDeps {
  repository: Pick<PluginRepository, 'searchRecords'>;
  reply: (msg: ExtensionToWebview) => void;
}

export interface ConditionFunctionPickerDeps {
  repository: Pick<PluginRepository, 'getConditionFunctions'>;
  reply: (msg: ExtensionToWebview) => void;
}

// Issue #212: unlike FormKeyPickerDeps/ConditionFunctionPickerDeps above, neither of these needs
// a PluginRepository — the native prompt itself is all the work, so `reply` is the whole bundle.
export interface RevertGroupConfirmDeps {
  reply: (msg: ExtensionToWebview) => void;
}

export interface AddScriptNameDeps {
  reply: (msg: ExtensionToWebview) => void;
}

// Issue #210: same "EditorID [FormKey]" label the deleted webview FormKeyPicker rendered.
function toFormKeyQuickPickItem(r: RecordSummary): vscode.QuickPickItem & { formKey: string } {
  return { label: r.editorId ? `${r.editorId} [${r.formKey}]` : r.formKey, formKey: r.formKey };
}

// Issue #210: the FormKey picker as a native QuickPick — the webview can't call
// vscode.window.createQuickPick itself, so this is the extension-host half of the bridge
// (pickFormKey on the webview side posts OPEN_FORM_KEY_PICKER and awaits the reply this
// produces). Seeded with `seed` (the current reference, or '' when adding a brand-new
// property) so the reference is visible instead of the old inline picker's empty-query defect;
// an immediate search on the seed pre-selects the matching item (setting `.value` doesn't fire
// onDidChangeValue on its own — QuickPick has no InputBox-style `valueSelection` to also
// highlight the *text*, so "pre-selected" here means the seeded item is active/highlighted in
// the results list, not the input text). Typing re-searches on the same 200ms debounce and
// `validTypes` filter the deleted picker used; a stale in-flight search is dropped via a
// sequence guard, never allowed to clobber a newer one. Resolves to the picked FormKey, or
// null on Escape/blur (no selection) — the caller leaves its field unchanged either way.
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
      const { items } = await deps.repository.searchRecords(query, validTypes);
      if (mySeq !== seq) return;
      const qpItems = items.map(toFormKeyQuickPickItem);
      quickPick.items = qpItems;
      const seeded = qpItems.find(i => i.formKey === seed);
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

// Issue #211: the condition-function picker as a native QuickPick — same bridge shape as
// pickFormKeyViaQuickPick above (the webview cannot call vscode.window.showQuickPick itself), but
// simpler: the function catalogue is bounded and game-scoped, so it's fetched once and handed to
// a plain `showQuickPick` rather than driven through `createQuickPick`'s debounced per-keystroke
// search. "Seeded with the current value" (AC1) is satisfied by sorting the seed to index 0 of
// the array passed to showQuickPick — showQuickPick has no activeItem/activeItems option (only
// createQuickPick does), so array order is the only way to pre-highlight an item; VS Code focuses
// the first item by default. A seed absent from the catalogue (or empty, e.g. a function-less
// value) leaves the array unreordered. Resolves to the picked function name, or null when
// dismissed without a selection (Escape/blur) — the caller leaves the condition unchanged, same
// convention as pickFormKeyViaQuickPick.
export async function pickConditionFunctionViaQuickPick(
  deps: ConditionFunctionPickerDeps, seed: string,
): Promise<string | null> {
  const all = await deps.repository.getConditionFunctions();
  const items = seed && all.includes(seed) ? [seed, ...all.filter(f => f !== seed)] : all;
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a condition function…' });
  return picked ?? null;
}

// Issue #212: the revert-group confirmation as a native modal warning — the webview can't call
// vscode.window.showWarningMessage itself, only the extension host can. Takes no deps (unlike
// the two QuickPick bridges above): RevertGroupConfirmDeps carries only `reply`, which belongs
// to the wrapper below, not this native call. `detail` is already composed by the caller (the
// webview, which holds the PendingChange[] members — see OPEN_REVERT_GROUP_CONFIRM's doc comment
// in messages.ts for why the formatting lives there instead of here). Modal dialogs have no
// Cancel button unless one is added explicitly; omitting one gives the dialog's own close
// (Escape/outside click) as the dismiss path, resolving `undefined` the same as an explicit
// Cancel would — so there is no separate "dismissed" branch to distinguish, matching the deleted
// RevertGroupConfirm's onCancel not distinguishing the two either.
export async function confirmRevertGroupViaNativeDialog(detail: string): Promise<boolean> {
  const picked = await vscode.window.showWarningMessage(
    'Revert this group? All linked edits are reverted together.', { modal: true, detail }, 'Revert',
  );
  return picked === 'Revert';
}

// Issue #212: the add-script dialog's name field as a native input box — same "webview can't
// call the native API itself" reasoning as every bridge above, and the same no-deps shape as
// confirmRevertGroupViaNativeDialog (AddScriptNameDeps carries only `reply`, used by the wrapper
// below). `validateInput` enforces the empty/whitespace rejection natively (VS Code disables its
// OK action and shows the message inline) — the same rule the deleted AddScriptDialog's
// `confirmDisabled` enforced client-side, so a blank name can never reach the
// ADD_SCRIPT_NAME_PICKED reply. Resolves null when the box is dismissed (Escape/blur,
// showInputBox resolves undefined) — the caller adds nothing, same as the deleted dialog's
// onCancel.
export async function pickScriptNameViaInputBox(): Promise<string | null> {
  const name = await vscode.window.showInputBox({
    prompt: 'Script name',
    validateInput: v => (v.trim() === '' ? 'Name is required' : null),
  });
  return name ?? null;
}

// Issue #211: extracted so routeRecordPanelMessage's own branch stays a single statement,
// matching the shape of every other branch below it — the "deps present?" guard (a no-op when
// this panel wasn't wired for the picker) and the QuickPick-then-reply sequence both live here
// instead of inline, keeping the dispatcher's own cyclomatic complexity from growing with every
// picker this bridge shape gets reused for.
async function replyFormKeyPicked(
  deps: FormKeyPickerDeps | undefined, m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER }>,
): Promise<void> {
  if (!deps) return;
  const formKey = await pickFormKeyViaQuickPick(deps, m.seed, m.validTypes);
  deps.reply({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: m.requestId, formKey });
}

// Issue #211: same shape as replyFormKeyPicked above, for the condition-function QuickPick.
async function replyConditionFunctionPicked(
  deps: ConditionFunctionPickerDeps | undefined, m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER }>,
): Promise<void> {
  if (!deps) return;
  const functionName = await pickConditionFunctionViaQuickPick(deps, m.seed);
  deps.reply({ type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId: m.requestId, functionName });
}

// Issue #212: same shape as replyFormKeyPicked/replyConditionFunctionPicked above, for the
// revert-group confirmation's native modal.
async function replyRevertGroupConfirmed(
  deps: RevertGroupConfirmDeps | undefined, m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM }>,
): Promise<void> {
  if (!deps) return;
  const confirmed = await confirmRevertGroupViaNativeDialog(m.detail);
  deps.reply({ type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId: m.requestId, confirmed });
}

// Issue #212: same shape again, for the add-script name's native input box.
async function replyAddScriptNamePicked(
  deps: AddScriptNameDeps | undefined, m: Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME }>,
): Promise<void> {
  if (!deps) return;
  const name = await pickScriptNameViaInputBox();
  deps.reply({ type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId: m.requestId, name });
}

// Issue #212: split out of routeRecordPanelMessage below so its own complexity doesn't grow
// every time another *Picker/*Confirm/*Name bridge is added — these four all share the same
// "deps optional → run the native prompt → reply" shape (see replyFormKeyPicked et al. above),
// so they're grouped here rather than adding a fifth/sixth branch to the main dispatcher.
async function routePromptMessage(m: WebviewToExtension, deps: RouteRecordPanelMessageDeps): Promise<void> {
  if (m.type === WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER) {
    await replyFormKeyPicked(deps.formKeyPicker, m);
  } else if (m.type === WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER) {
    await replyConditionFunctionPicked(deps.conditionFunctionPicker, m);
  } else if (m.type === WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM) {
    await replyRevertGroupConfirmed(deps.revertGroupConfirm, m);
  } else if (m.type === WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME) {
    await replyAddScriptNamePicked(deps.addScriptName, m);
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
  } else if (m.type === WEBVIEW_TO_EXTENSION.PENDING_CHANGED) {
    deps.reveal?.provider.refresh();
  } else if (m.type === WEBVIEW_TO_EXTENSION.LOG) {
    deps.channel[m.level](m.message);
  } else {
    await routePromptMessage(m, deps);
  }
}
