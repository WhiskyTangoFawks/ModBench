import * as vscode from 'vscode';
import type { CompareResult, MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { PathHop } from '../wire/messages';

/** Where a cell's text lives: the record, the plugin copy of it, and the field's path (ADR-0012). */
export interface FieldAddress {
  formKey: string;
  plugin: string;
  origin: string;
  path: PathHop[];
}

export interface OpenExtendedFieldEditorParams extends FieldAddress {
  recordLabel: string;
  fieldName: string;
  readOnly: boolean;
}

export interface ExtendedFieldDocumentsDeps {
  client: Pick<MEditClient, 'getComparison' | 'onNotification'>;
  reporter: Reporter;
  // Runs once per save, not once per tab: a tab can be saved any number of times while open, and
  // each save is its own commit of the leaf.
  commit: (field: FieldAddress, value: string) => Promise<void>;
}

export const EDITABLE_FIELD_SCHEME = 'modbench-field';
export const READONLY_FIELD_SCHEME = 'modbench-field-readonly';

// Mirrors the backend's `ColumnKey.Of`: the Data origin is elided.
const columnKeyOf = (plugin: string, origin: string): string =>
  origin.toLowerCase() === 'data' ? plugin : `${plugin}|${origin}`;

function isFieldAddress(value: unknown): value is FieldAddress {
  if (typeof value !== 'object' || value === null) return false;
  return ['formKey', 'plugin', 'origin'].every(name => typeof Reflect.get(value, name) === 'string')
    && Array.isArray(Reflect.get(value, 'path'));
}

function textAt(result: CompareResult, field: FieldAddress): string | undefined {
  const column = columnKeyOf(field.plugin, field.origin);
  const [root, ...hops] = field.path;
  if (root?.kind !== 'member' || !result.overrides.some(o => columnKeyOf(o.plugin, o.origin) === column)) return undefined;
  let diff = result.diffs.find(d => d.fieldName === root.name);
  for (const hop of hops) {
    const children = diff?.children ?? [];
    diff = hop.kind === 'member'
      ? children.find(c => c.fieldName === hop.name)
      : children.find(c => c.indexes?.[column] === hop.index);
  }
  if (!diff) return undefined;
  const value = diff.values[column];
  return typeof value === 'string' ? value : '';
}

interface KnownField { address: FieldAddress; version: number }

// A scheme's registration is read-only or not as a whole, so the two schemes are two providers.
class FieldFileSystem implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly known = new Map<string, { uri: vscode.Uri; field: KnownField }>();

  constructor(private readonly deps: ExtendedFieldDocumentsDeps, private readonly readOnly: boolean) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { text, field } = await this.read(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: field.version, size: new TextEncoder().encode(text).byteLength };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return new TextEncoder().encode((await this.read(uri)).text);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    if (this.readOnly) throw vscode.FileSystemError.NoPermissions(uri);
    const field = this.fieldAt(uri);
    field.version += 1;
    await this.deps.commit(field.address, new TextDecoder().decode(content));
  }

  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(oldUri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(oldUri); }

  forget(uri: vscode.Uri): void { this.known.delete(uri.toString()); }

  changedWhere(affects: (field: FieldAddress) => boolean): void {
    const events: vscode.FileChangeEvent[] = [];
    for (const { uri, field } of this.known.values()) {
      if (!affects(field.address)) continue;
      field.version += 1;
      events.push({ type: vscode.FileChangeType.Changed, uri });
    }
    if (events.length > 0) this.changes.fire(events);
  }

  dispose(): void { this.changes.dispose(); }

  private fieldAt(uri: vscode.Uri): KnownField {
    const key = uri.toString();
    const known = this.known.get(key);
    if (known) return known.field;
    const address: unknown = JSON.parse(uri.query);
    if (!isFieldAddress(address)) throw vscode.FileSystemError.FileNotFound(uri);
    const field = { address, version: 1 };
    this.known.set(key, { uri, field });
    return field;
  }

  private async read(uri: vscode.Uri): Promise<{ text: string; field: KnownField }> {
    const field = this.fieldAt(uri);
    const { formKey, plugin } = field.address;
    const result = await this.deps.client.getComparison(formKey);
    if (!result) throw vscode.FileSystemError.FileNotFound(`The record ${formKey} is gone.`);
    const text = textAt(result, field.address);
    if (text === undefined) throw vscode.FileSystemError.FileNotFound(`The record ${formKey} has no such field in ${plugin}.`);
    return { text, field };
  }
}

const asSegment = (text: string): string => text.replaceAll('/', '_');

// The address rides in the query, so two columns that share a filename (ADR-0012) are two
// documents and a restored tab can read its field again; the last path segment is the tab's title.
function fieldUri(params: OpenExtendedFieldEditorParams): vscode.Uri {
  const { formKey, plugin, origin, path } = params;
  return vscode.Uri.from({
    scheme: params.readOnly ? READONLY_FIELD_SCHEME : EDITABLE_FIELD_SCHEME,
    path: `/${asSegment(params.recordLabel)}/${asSegment(params.fieldName)} [${asSegment(plugin)}]`,
    query: JSON.stringify({ formKey, plugin, origin, path }),
  });
}

/** The documents behind "Open field value": each cell's text is a file of the Editor's own
 *  schemes, read from mEdit when VS Code asks, and a save is the write. */
export class ExtendedFieldDocuments implements vscode.Disposable {
  private readonly editable: FieldFileSystem;
  private readonly readOnly: FieldFileSystem;
  private readonly registrations: vscode.Disposable[];

  constructor(private readonly deps: ExtendedFieldDocumentsDeps) {
    this.editable = new FieldFileSystem(deps, false);
    this.readOnly = new FieldFileSystem(deps, true);
    const both = [this.editable, this.readOnly];
    const unsubscribes = [
      deps.client.onNotification('rows-changed', event => {
        for (const files of both) files.changedWhere(field => event.keys.includes(field.formKey));
      }),
      deps.client.onNotification('plugin-changed', event => {
        for (const files of both) files.changedWhere(field => field.plugin === event.plugin && field.origin === event.origin);
      }),
    ];
    this.registrations = [
      vscode.workspace.registerFileSystemProvider(EDITABLE_FIELD_SCHEME, this.editable),
      vscode.workspace.registerFileSystemProvider(READONLY_FIELD_SCHEME, this.readOnly, { isReadonly: true }),
      vscode.workspace.onDidCloseTextDocument(doc => { for (const files of both) files.forget(doc.uri); }),
      new vscode.Disposable(() => { for (const unsubscribe of unsubscribes) unsubscribe(); }),
      this.editable,
      this.readOnly,
    ];
  }

  async open(params: OpenExtendedFieldEditorParams): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(fieldUri(params));
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    } catch (err) {
      // The user opened it from a cell's menu, an explicit action (ADR-0019).
      this.deps.reporter.report('error', 'Could not open the extended editor.', errorMessage(err));
    }
  }

  dispose(): void {
    for (const registration of this.registrations) registration.dispose();
  }
}
