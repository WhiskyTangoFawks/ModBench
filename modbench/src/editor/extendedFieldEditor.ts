import * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

/** Which cell a tab edits: the record, the field and the plugin (ADR-0012). */
export interface ExtendedFieldIdentity {
  recordLabel: string;
  fieldName: string;
  plugin: string;
  origin: string;
}

export interface OpenExtendedFieldEditorParams extends ExtendedFieldIdentity {
  value: string;
  readOnly: boolean;
}

export interface ExtendedFieldEditorDeps {
  // Runs once per save, not once per tab: a tab can be saved any number of times while open, and
  // each save is its own commit of the leaf.
  onCommit: (value: string) => Promise<void> | void;
  reporter: Reporter;
}

export const EDITABLE_FIELD_SCHEME = 'modbench-field';
export const READONLY_FIELD_SCHEME = 'modbench-field-readonly';

interface OpenField {
  content: Uint8Array;
  version: number;
  onCommit: ExtendedFieldEditorDeps['onCommit'];
}

// A scheme's registration is read-only or not as a whole, so the two schemes are two providers.
class FieldFileSystem implements vscode.FileSystemProvider {
  readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;
  readonly fields = new Map<string, OpenField>();

  constructor(private readonly readOnly: boolean) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  stat(uri: vscode.Uri): vscode.FileStat {
    const { content, version } = this.fieldAt(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: version, size: content.byteLength };
  }

  readFile(uri: vscode.Uri): Uint8Array { return this.fieldAt(uri).content; }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    if (this.readOnly) throw vscode.FileSystemError.NoPermissions(uri);
    const field = this.fieldAt(uri);
    field.content = content;
    field.version += 1;
    await field.onCommit(new TextDecoder().decode(content));
  }

  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(oldUri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(oldUri); }

  private fieldAt(uri: vscode.Uri): OpenField {
    const field = this.fields.get(uri.toString());
    if (!field) throw vscode.FileSystemError.FileNotFound(uri);
    return field;
  }
}

const asSegment = (text: string): string => text.replaceAll('/', '_');

// The origin rides in the query, so two columns that share a filename (ADR-0012) are two
// documents; the last path segment is the tab's title.
function fieldUri(field: ExtendedFieldIdentity, readOnly: boolean): vscode.Uri {
  return vscode.Uri.from({
    scheme: readOnly ? READONLY_FIELD_SCHEME : EDITABLE_FIELD_SCHEME,
    path: `/${asSegment(field.recordLabel)}/${asSegment(field.fieldName)} [${asSegment(field.plugin)}]`,
    query: field.origin,
  });
}

/** The documents behind "Open field value": each cell's text is a file of the Editor's own
 *  schemes, so VS Code tracks dirtiness and the close prompt, and a save is the write. */
export class ExtendedFieldDocuments implements vscode.Disposable {
  private readonly editable = new FieldFileSystem(false);
  private readonly readOnly = new FieldFileSystem(true);
  private readonly registrations: vscode.Disposable[] = [
    vscode.workspace.registerFileSystemProvider(EDITABLE_FIELD_SCHEME, this.editable),
    vscode.workspace.registerFileSystemProvider(READONLY_FIELD_SCHEME, this.readOnly, { isReadonly: true }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      this.editable.fields.delete(doc.uri.toString());
      this.readOnly.fields.delete(doc.uri.toString());
    }),
  ];

  async open(params: OpenExtendedFieldEditorParams, deps: ExtendedFieldEditorDeps): Promise<void> {
    const uri = fieldUri(params, params.readOnly);
    const fields = params.readOnly ? this.readOnly.fields : this.editable.fields;
    const key = uri.toString();
    const alreadyOpen = fields.has(key);
    if (!alreadyOpen) {
      fields.set(key, { content: new TextEncoder().encode(params.value), version: 1, onCommit: deps.onCommit });
    }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    } catch (err) {
      if (!alreadyOpen) fields.delete(key);
      // The user opened it from a cell's menu, an explicit action (ADR-0019).
      deps.reporter.report('error', 'Could not open the extended editor.', errorMessage(err));
    }
  }

  dispose(): void {
    for (const registration of this.registrations) registration.dispose();
  }
}
