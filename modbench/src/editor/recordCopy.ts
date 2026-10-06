import type * as vscode from 'vscode';
import type { RecordToOpen } from './recordOpenPlan';

/** A plugin's copy of a record, as a document of that one copy states it. */
export type RecordCopy = Required<RecordToOpen>;

// The copy rides in the URI's query, its plugin whole (ADR-0012), so a restored tab reads it again.
export const copyQuery = ({ formKey, plugin }: RecordCopy): string =>
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
