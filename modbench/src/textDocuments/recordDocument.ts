import * as vscode from 'vscode';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';
import type { PluginAddress } from '../wire/pluginAddress';
import { holdsNoCopy, type RecordCopy } from '../wire/recordCopy';

// What Text documents reads of mEdit's answers, by shape: a box never references a box of its own
// band (layers.d2), and the mEdit client is a repository too.
export interface RecordDocumentClient {
  getRecordOwners(formKey: string): Promise<PluginAddress[] | ReadFailed>;
  getCopyDocument(plugin: PluginAddress, formKey: string): Promise<CopyDocumentAt | null | ReadFailed>;
}

export interface CopyDocumentAt { kind: 'OwnFile' | 'ContainersFile' | 'Rendered'; location: string }

export type RecordDocument = { uri: vscode.Uri } | { refused: string };

export const RENDERED_DOCUMENT_SCHEME = 'modbench-rendered';
export const CHILD_RECORD_SCHEME = 'modbench-child-record';
/** The schemes of the documents over a record's file: its own, and each of its child records'. */
export const CONTAINER_SCHEMES: ReadonlySet<string> = new Set(['file', CHILD_RECORD_SCHEME]);

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

// VS Code shows the path beside the tab's title; the query tells apart two copies of one path.
function renderedDocumentUri(copy: RecordCopy, fileName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: RENDERED_DOCUMENT_SCHEME, path: `/${encodeURIComponent(copy.plugin.origin)}/${copy.plugin.name}/${fileName}`, query: copyQuery(copy),
  });
}

// The path is the container's file, so VS Code shows where the child lives; the query tells two
// children of one file apart.
const childRecordUri = (copy: RecordCopy, containerFile: string): vscode.Uri =>
  vscode.Uri.file(containerFile).with({ scheme: CHILD_RECORD_SCHEME, query: copyQuery(copy) });

/** Why no one plugin's copy opens: several plugins own the record, none of them active, and a gesture that opens it asks
 *  which; or mEdit could not say, and `owners` is empty. */
export interface OwnerRefused { refused: string; owners: readonly PluginAddress[] }

/** The plugin whose copy a record given without a plugin opens as (editor.md, Opening, story 8); undefined when no plugin
 *  owns it. */
export async function ownerOf(
  client: Pick<RecordDocumentClient, 'getRecordOwners'>, formKey: string,
): Promise<PluginAddress | OwnerRefused | undefined> {
  const owners = await client.getRecordOwners(formKey);
  if (isReadFailed(owners)) return { refused: failureReason(owners), owners: [] };
  const [only, ...others] = owners;
  if (others.length === 0) return only;
  const named = owners.map(({ name, origin }) => `${name} (${origin})`).join(', ');
  return { refused: `No active plugin holds ${formKey}, and several compiled plugins do: ${named}. Give the plugin whose copy to open.`, owners };
}

/** The document a record opens as (editor.md, Opening, stories 8 to 10); undefined when given without a plugin that no
 *  plugin owns. */
export async function recordDocument(
  client: RecordDocumentClient, { formKey, plugin: given }: Pick<RecordCopy, 'formKey'> & Partial<RecordCopy>,
): Promise<RecordDocument | undefined> {
  const owner = given ?? await ownerOf(client, formKey);
  if (owner === undefined || 'refused' in owner) return owner;
  return copyDocument(client, { formKey, plugin: owner });
}

export async function copyDocument(client: RecordDocumentClient, { formKey, plugin }: RecordCopy): Promise<RecordDocument> {
  const document = await client.getCopyDocument(plugin, formKey);
  if (isReadFailed(document)) return { refused: failureReason(document) };
  if (document === null) return { refused: holdsNoCopy({ formKey, plugin }) };
  return { uri: copyDocumentUri({ formKey, plugin }, document) };
}

export function copyDocumentUri(copy: RecordCopy, { kind, location }: CopyDocumentAt): vscode.Uri {
  switch (kind) {
    case 'OwnFile': return vscode.Uri.file(location);
    case 'ContainersFile': return childRecordUri(copy, location);
    case 'Rendered': return renderedDocumentUri(copy, location);
  }
}
