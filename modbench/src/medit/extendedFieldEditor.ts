import * as vscode from 'vscode';
import { mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from './messages';
import type { Reporter } from '../modmanager/deployer';

// Issue #230: filesystem-safe rendering of one path segment (a record label, field name, or
// plugin name — any of which may carry a FormKey's `:`, or characters Windows paths reject
// outright). Collapsed whitespace and a length cap keep the result a sane single segment even for
// an unusually long EditorID; the `|| '_'` guards the (practically unreachable, but real) case of
// a segment that sanitizes down to nothing.
function sanitizeForPath(segment: string): string {
  return segment
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '_';
}

// Issue #230 (seam: tab naming): deterministic — not random — per record+field+plugin(+column,
// #242), so re-double-clicking the same cell reveals the same already-open tab (VS Code's own
// per-URI reuse) instead of opening a duplicate. Directory keyed by the record (readable, and
// groups a record's several open fields together); filename is what the tab title shows by
// default — `Description [SomePlugin.esp].txt`, naming the field and the plugin without repeating
// the record identity the directory already carries.
//
// Issue #242: `column` is the same disk/pending discriminant #232 gave `FocusedCell` — a pending
// cell shares record+field+plugin exactly with its disk companion (a pending column only ever
// exists alongside a disk column for the same plugin), so without a fourth axis here the two
// would alias onto the same temp file/tab. Folded into the *filename*, not a new directory, so
// the record's fields still group together on disk and the discriminant is also the one thing the
// user sees (the tab title), telling apart two open tabs for the same field at a glance.
//
// #304 / ADR-0036: `origin` is its own directory segment, between the record and the field —
// unlike `column` above, folded unconditionally, not into the filename. Two columns can now share
// a filename (a shadowed copy), and without origin here they'd alias onto the same temp file:
// column A's tab would silently show column B's content (right commit target — the closure is
// bound in the webview — wrong displayed content). No "elide the Data origin" branch, unlike
// columnKey()'s own convention: the directory is never what the user reads (the tab title stays
// the plain filename, per ADR-0036 — "origin is never what the user reads"), so there is nothing
// to keep quiet for the common single-origin case and no collision-dependent rule to get wrong.
// Run through the same sanitizeForPath every other segment already gets — a mod folder name is a
// real directory name MO2 already accepted, but on whatever filesystem created it, not
// necessarily this one, and it can carry columnKey()'s own `|` delimiter.
export function extendedEditorPath(
  tempRoot: string, recordLabel: string, fieldName: string, plugin: string, origin: string, column?: 'pending',
): string {
  const dir = join(tempRoot, sanitizeForPath(recordLabel), sanitizeForPath(origin));
  const suffix = column === 'pending' ? ' (Pending)' : '';
  const file = `${sanitizeForPath(fieldName)} [${sanitizeForPath(plugin)}]${suffix}.txt`;
  return join(dir, file);
}

export interface OpenExtendedFieldEditorParams {
  requestId: string;
  value: string;
  recordLabel: string;
  fieldName: string;
  plugin: string;
  // #272 / ADR-0036: required alongside `plugin`, consistent with every other column-identity
  // message in this ticket — but deliberately NOT threaded into extendedEditorPath below. Two
  // same-filename columns sharing a temp-file path (right target, wrong content) is unreachable
  // until #34 (nothing loads such a pair yet); the fix is path derivation, which is #34-shaped.
  // Carrying `origin` on the message now means #34 only has to change extendedEditorPath, not
  // this message's shape too.
  origin: string;
  readOnly: boolean;
  // Issue #242: FocusedCell's own disk/pending discriminant (#232), mirrored here — absent means
  // the disk cell, `'pending'` its independent companion. See extendedEditorPath's own comment for
  // why this can't be left out.
  column?: 'pending';
}

export interface ExtendedFieldEditorDeps {
  // Issue #230 (seam: vehicle mechanics): the temp directory every extended-editor file is
  // written under — injected rather than computed from `os.tmpdir()` here, so a test can point it
  // at its own throwaway directory instead of littering (and depending on) the real OS temp dir.
  tempRoot: string;
  reply: (msg: ExtensionToWebview) => void;
  log: (msg: string) => void;
  reporter: Reporter;
}

// Issue #230: opens a `string` cell's value as a real editor tab — a temp file, not a
// FileSystemProvider and not an `untitled:` document (design note:
// docs/specs/medit-record-editor.md, Editing § extended editor). A real file gets native
// dirty-tracking and the native "Save changes to X? Save/Don't Save/Cancel" close prompt for
// free, so abandoning it (closing without saving) commits nothing without any code here having to
// enforce that — and read-only enforcement is the OS file-permission bit VS Code already honors
// (`chmod` below), not a bespoke read-only UI state.
//
// Issue #230 (seam: commit trigger): each `Ctrl+S` re-sends the current content through
// EXTENDED_EDITOR_COMMITTED — the same discrete, explicit-action shape every other commit in this
// surface has (never on keystroke, never only on close). Closing sends only
// EXTENDED_EDITOR_CLOSED, the signal nativeBridge needs to drop its own bookkeeping for this
// requestId — never a value, since closing alone commits nothing beyond whatever saves already
// happened.
export async function openExtendedFieldEditor(
  params: OpenExtendedFieldEditorParams, deps: ExtendedFieldEditorDeps,
): Promise<void> {
  const path = extendedEditorPath(deps.tempRoot, params.recordLabel, params.fieldName, params.plugin, params.origin, params.column);
  try {
    await mkdir(join(path, '..'), { recursive: true });
    // Issue #230 (review fix): the path is deterministic (same record+field+plugin -> same
    // file), so a *second* open of an immutable cell finds a file already `chmod`-ed 0o444 by
    // its first open — writeFile against a non-writable file throws EACCES. Force it writable
    // before writing, every open, not just the first; ENOENT (nothing to chmod yet — the very
    // first open) is the one error this ignores, since mkdir above already guarantees the
    // parent directory exists for the writeFile that follows.
    await chmod(path, 0o644).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
    await writeFile(path, params.value, 'utf8');
    // Issue #230 (seam: immutable column): read-only, not absent — a read-only tab is still the
    // only way to read a long value in full. Enforced by the OS permission bit rather than any
    // renderer-side state: VS Code shows a locked, uneditable editor for a non-writable local
    // file natively, so there is nothing bespoke to build or to get out of sync. Applied *after*
    // the write above (not folded into a single chmod before it) so this is the one call that
    // decides the file's resting permissions on every open, independent of whichever transient
    // writable state the write itself needed.
    await chmod(path, params.readOnly ? 0o444 : 0o644);

    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });

    const saveListener = vscode.workspace.onDidSaveTextDocument(savedDoc => {
      if (savedDoc.uri.fsPath !== uri.fsPath) return;
      deps.reply({ type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId: params.requestId, value: savedDoc.getText() });
    });
    const closeListener = vscode.workspace.onDidCloseTextDocument(closedDoc => {
      if (closedDoc.uri.fsPath !== uri.fsPath) return;
      saveListener.dispose();
      closeListener.dispose();
      deps.reply({ type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED, requestId: params.requestId });
      // Best-effort: the temp dir is reclaimed by the OS regardless, and nothing user-facing
      // depends on this succeeding — logged, not surfaced, per the "background/recoverable"
      // row of the error-surfacing table (ADR-0026), not the "explicit action failed" one (the
      // user's close already succeeded; only cleanup after it didn't).
      void unlink(path).catch((err: unknown) => {
        deps.log(`[extendedFieldEditor] could not delete temp file ${path}: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  } catch (err) {
    // The user double-clicked a cell — an explicit action — so a failure here is ADR-0026's
    // "explicit action failed" row: error notification + log, not a silent swallow.
    deps.reporter.report('error', 'Could not open the extended editor.', err instanceof Error ? err.message : String(err));
    // Issue #230 (review fix): no tab ever opened on this path, so there is no
    // onDidCloseTextDocument left to fire EXTENDED_EDITOR_CLOSED the normal way — without this,
    // nativeBridge's requestId -> onCommit map entry (registered optimistically, before any
    // reply exists) would never be deleted. Reusing EXTENDED_EDITOR_CLOSED rather than inventing
    // a distinct failure message keeps the webview's cleanup to the one signal it already knows:
    // "this requestId is done, stop tracking it."
    deps.reply({ type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED, requestId: params.requestId });
  }
}
