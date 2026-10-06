import * as vscode from 'vscode';
import type { MEditClient, NotificationPayloads } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
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

export type CopyChanged = (copy: RecordCopy) => boolean;

/** Hands `changedWhere` the copies mEdit reports changed: those a rows-changed report touches, as
 *  `touches` reads it, each copy of a plugin mEdit read again whole, and every copy when its reports
 *  resume, since one may have been missed. */
export function followReportedCopies(
  client: Pick<MEditClient, 'onNotification' | 'onReconnected'>,
  changedWhere: (affects: CopyChanged) => void,
  touches: (report: NotificationPayloads['rows-changed']) => CopyChanged,
): vscode.Disposable {
  const unsubscribes = [
    client.onNotification('rows-changed', (report) => { changedWhere(touches(report)); }),
    client.onNotification('plugin-changed', ({ plugin }) => { changedWhere((copy) => samePluginAddress(copy.plugin, plugin)); }),
    client.onReconnected(() => { changedWhere(() => true); }),
  ];
  return new vscode.Disposable(() => { for (const unsubscribe of unsubscribes) unsubscribe(); });
}
