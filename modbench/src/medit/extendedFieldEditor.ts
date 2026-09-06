import * as vscode from 'vscode';
import { mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reporter } from '../modmanager/deployer';

// Any segment may carry a FormKey's `:` or characters Windows paths reject. Collapsed whitespace
// and a length cap keep the result one sane segment; `|| '_'` guards a segment that sanitizes
// down to nothing.
function sanitizeForPath(segment: string): string {
  return segment
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '_';
}

// Deterministic per record+field+plugin, so re-opening the same cell reveals the same tab.
// `origin` is its own directory segment: two columns can share a filename and would otherwise
// alias onto one temp file (ADR-0036).
export function extendedEditorPath(
  tempRoot: string, recordLabel: string, fieldName: string, plugin: string, origin: string,
): string {
  const dir = join(tempRoot, sanitizeForPath(recordLabel), sanitizeForPath(origin));
  const file = `${sanitizeForPath(fieldName)} [${sanitizeForPath(plugin)}].txt`;
  return join(dir, file);
}

export interface OpenExtendedFieldEditorParams {
  value: string;
  recordLabel: string;
  fieldName: string;
  plugin: string;
  // ADR-0036: threaded into extendedEditorPath so two same-filename columns never alias onto one
  // temp file.
  origin: string;
  readOnly: boolean;
}

export interface ExtendedFieldEditorDeps {
  // The temp directory every extended-editor file is
  // written under — injected rather than computed from `os.tmpdir()` here, so a test can point it
  // at its own throwaway directory instead of littering (and depending on) the real OS temp dir.
  tempRoot: string;
  // Runs once per save, not once per tab: a tab can be saved any number of times while open, and
  // each save is its own commit of the leaf.
  onCommit: (value: string) => Promise<void> | void;
  log: (msg: string) => void;
  reporter: Reporter;
}

// A temp file, not a FileSystemProvider: a real file gets native dirty-tracking and the native
// close prompt for free, so abandoning it commits nothing, and read-only is the OS permission bit
// VS Code already honors.
export async function openExtendedFieldEditor(
  params: OpenExtendedFieldEditorParams, deps: ExtendedFieldEditorDeps,
): Promise<void> {
  const path = extendedEditorPath(deps.tempRoot, params.recordLabel, params.fieldName, params.plugin, params.origin);
  try {
    await mkdir(join(path, '..'), { recursive: true });
    // A second open of an immutable cell finds a file already `chmod`-ed 0o444 by the first, and
    // writeFile against a non-writable file throws EACCES. ENOENT is the one error to ignore —
    // nothing exists to chmod yet.
    await chmod(path, 0o644).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
    await writeFile(path, params.value, 'utf8');
    // Read-only, not absent — a read-only tab is still the only way to read a long value in full,
    // and the OS permission bit is enforcement VS Code already honors. Applied after the write,
    // which needs it writable.
    await chmod(path, params.readOnly ? 0o444 : 0o644);

    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });

    const saveListener = vscode.workspace.onDidSaveTextDocument(async savedDoc => {
      if (savedDoc.uri.fsPath !== uri.fsPath) return;
      await deps.onCommit(savedDoc.getText());
    });
    const closeListener = vscode.workspace.onDidCloseTextDocument(async closedDoc => {
      if (closedDoc.uri.fsPath !== uri.fsPath) return;
      saveListener.dispose();
      closeListener.dispose();
      // Best-effort: the OS reclaims the temp dir regardless, so this is logged, not surfaced
      // (ADR-0026). Awaited so the listener's promise settles only once the file is gone — an
      // orphaned unlink races anything observing the path.
      await unlink(path).catch((err: unknown) => {
        deps.log(`[extendedFieldEditor] could not delete temp file ${path}: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  } catch (err) {
    // The user double-clicked a cell — an explicit action — so a failure here is ADR-0026's
    // "explicit action failed" row: error notification + log, not a silent swallow.
    deps.reporter.report('error', 'Could not open the extended editor.', err instanceof Error ? err.message : String(err));
  }
}
