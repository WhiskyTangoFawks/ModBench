import * as vscode from 'vscode';

// The members read of mEdit's answers, named here because not every box using this lib
// references the client or the wire (target-architecture.md, Maintaining).
interface PluginAddress { name: string; origin: string }

export interface RecordDocumentClient {
  getRecordOwner(formKey: string): Promise<PluginAddress | undefined>;
  getRecordFile(plugin: PluginAddress, formKey: string): Promise<{ path?: string | null } | null>;
  getRecordOfFile(path: string): Promise<{ formKey: string }>;
  getRenderedDocument(plugin: PluginAddress, formKey: string): Promise<{ fileName: string } | null>;
}

/** A plugin's copy of a record, as a document of that one copy states it. */
export interface RecordCopy { formKey: string; plugin: PluginAddress }

export const RENDERED_DOCUMENT_SCHEME = 'modbench-rendered';
export const CHILD_RECORD_SCHEME = 'modbench-child-record';

// The copy rides in the URI's query, its plugin whole (ADR-0012), so a restored tab reads it again.
const copyQuery = ({ formKey, plugin }: RecordCopy): string =>
  new URLSearchParams({ formKey, name: plugin.name, origin: plugin.origin }).toString();

export function copyOf(uri: vscode.Uri): RecordCopy {
  const query = new URLSearchParams(uri.query);
  const stated = (key: string): string => {
    const value = query.get(key);
    if (!value) throw new Error(`The document ${uri.path} states no ${key}.`);
    return value;
  };
  return { formKey: stated('formKey'), plugin: { name: stated('name'), origin: stated('origin') } };
}

export const holdsNoCopy = ({ formKey, plugin }: RecordCopy): Error =>
  new Error(`${plugin.name} (${plugin.origin}) holds no ${formKey}.`);

// The path is what VS Code shows: its last segment titles the tab, and the plugin's segments
// before it tell apart two copies of one name.
export function renderedDocumentUri(copy: RecordCopy, fileName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: RENDERED_DOCUMENT_SCHEME, path: `/${copy.plugin.origin}/${copy.plugin.name}/${fileName}`, query: copyQuery(copy),
  });
}

// The path is the container's file, so VS Code shows where the child lives; the query tells two
// children of one file apart.
export const childRecordUri = (copy: RecordCopy, containerFile: string): vscode.Uri =>
  vscode.Uri.file(containerFile).with({ scheme: CHILD_RECORD_SCHEME, query: copyQuery(copy) });

/** The document a record opens as (editor.md, Opening, stories 8 to 10); undefined when it names
 *  no plugin and no active plugin holds it. */
export async function recordDocumentUri(
  client: RecordDocumentClient, { formKey, plugin: given }: { formKey: string; plugin?: PluginAddress },
): Promise<vscode.Uri | undefined> {
  const plugin = given ?? await client.getRecordOwner(formKey);
  if (!plugin) return undefined;
  const file = await client.getRecordFile(plugin, formKey);
  if (file === null) throw holdsNoCopy({ formKey, plugin });
  if (!file.path) {
    const rendered = await client.getRenderedDocument(plugin, formKey);
    if (rendered === null) throw holdsNoCopy({ formKey, plugin });
    return renderedDocumentUri({ formKey, plugin }, rendered.fileName);
  }
  if ((await client.getRecordOfFile(file.path)).formKey === formKey) return vscode.Uri.file(file.path);
  return childRecordUri({ formKey, plugin }, file.path);
}
