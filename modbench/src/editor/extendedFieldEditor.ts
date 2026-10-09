import * as vscode from 'vscode';
import type { CompareResult, MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import { isPluginAddress, type PathHop, type StringValueContext } from '../wire/messages';
import { columnKey } from '../wire/columnKey';
import { pluginAddressOf, samePluginAddress } from '../wire/pluginAddress';
import type { EditAddress } from './recordTab';
import { followReportedCopies, type CopyChanged } from './recordCopy';
import { answerOf } from '../wire/readFailed';

/** Where a cell's text lives: the plugin copy of the record, and the field's path. */
export interface FieldAddress extends EditAddress { path: PathHop[] }

export type OpenExtendedFieldEditorParams =
  Pick<StringValueContext, 'formKey' | 'plugin' | 'origin' | 'path' | 'recordLabel' | 'fieldName' | 'readOnly'>;

export interface ExtendedFieldDocumentsDeps {
  client: Pick<MEditClient, 'getComparison' | 'onNotification' | 'onReconnected'>;
  reporter: Reporter;
  // Runs once per save, not once per tab: a tab can be saved any number of times while open, and
  // each save is its own commit of the leaf.
  commit: (field: FieldAddress, value: string) => Promise<void>;
}

const EDITABLE_FIELD_SCHEME = 'modbench-field';
const READONLY_FIELD_SCHEME = 'modbench-field-readonly';

function isFieldAddress(value: unknown): value is FieldAddress {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'formKey') === 'string' && isPluginAddress(Reflect.get(value, 'plugin'))
    && Array.isArray(Reflect.get(value, 'path'));
}

function textAt(result: CompareResult, field: FieldAddress): string | undefined {
  const column = columnKey(field.plugin);
  const [root, ...hops] = field.path;
  if (root?.kind !== 'member' || !result.overrides.some(o => samePluginAddress(pluginAddressOf(o), field.plugin))) return undefined;
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

  changedWhere(affects: CopyChanged): void {
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
    const result = answerOf(await this.deps.client.getComparison(formKey));
    if (!result) throw vscode.FileSystemError.FileNotFound(`The record ${formKey} is gone.`);
    const text = textAt(result, field.address);
    if (text === undefined) throw vscode.FileSystemError.FileNotFound(`The record ${formKey} has no such field in ${plugin.name}.`);
    return { text, field };
  }
}

const asSegment = (text: string): string => text.replaceAll('/', '_');

// The address rides in the query, so two columns that share a filename (ADR-0012) are two
// documents and a restored tab can read its field again; the last path segment is the tab's title.
function fieldUri(params: OpenExtendedFieldEditorParams): vscode.Uri {
  const { formKey, path } = params;
  const address: FieldAddress = { formKey, plugin: pluginAddressOf(params), path };
  return vscode.Uri.from({
    scheme: params.readOnly ? READONLY_FIELD_SCHEME : EDITABLE_FIELD_SCHEME,
    path: `/${asSegment(params.recordLabel)}/${asSegment(params.fieldName)} [${asSegment(params.plugin)}]`,
    query: JSON.stringify(address),
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
    this.registrations = [
      vscode.workspace.registerFileSystemProvider(EDITABLE_FIELD_SCHEME, this.editable),
      vscode.workspace.registerFileSystemProvider(READONLY_FIELD_SCHEME, this.readOnly, { isReadonly: true }),
      vscode.workspace.onDidCloseTextDocument(doc => { for (const files of both) files.forget(doc.uri); }),
      followReportedCopies(deps.client, (affects) => { for (const files of both) files.changedWhere(affects); },
        ({ keys }) => (field) => keys.includes(field.formKey)),
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
