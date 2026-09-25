import * as vscode from 'vscode';
import { mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import type { Reporter } from '../ports/reporter';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';

/** Which cell a tab edits: the record, the field and the plugin (ADR-0012). */
export interface ExtendedFieldIdentity {
  recordLabel: string;
  fieldName: string;
  plugin: string;
  origin: string;
}

/** Where a cell's tab is written: the file, and the folder that must exist for it. */
export interface ExtendedFieldFile {
  folder: string;
  file: string;
}

export interface OpenExtendedFieldEditorParams extends ExtendedFieldIdentity {
  value: string;
  readOnly: boolean;
}

export interface ExtendedFieldEditorDeps {
  // The composition root's answer for where a cell's tab is written: this view builds no path.
  fieldFile: (field: ExtendedFieldIdentity) => ExtendedFieldFile;
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
  const { folder, file: path } = deps.fieldFile(params);
  try {
    await mkdir(folder, { recursive: true });
    // A second open of an immutable cell finds a file already `chmod`-ed 0o444 by the first, and
    // writeFile against a non-writable file throws EACCES. ENOENT is the one error to ignore —
    // nothing exists to chmod yet.
    await chmod(path, 0o644).catch((err: unknown) => {
      if (errnoCode(err) !== 'ENOENT') throw err;
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
      // (ADR-0019). Awaited so the listener's promise settles only once the file is gone — an
      // orphaned unlink races anything observing the path.
      await unlink(path).catch((err: unknown) => {
        deps.log(`[extendedFieldEditor] could not delete temp file ${path}: ${errorMessage(err)}`);
      });
    });
  } catch (err) {
    // The user double-clicked a cell — an explicit action — so a failure here is ADR-0019's
    // "explicit action failed" row: error notification + log, not a silent swallow.
    deps.reporter.report('error', 'Could not open the extended editor.', errorMessage(err));
  }
}
