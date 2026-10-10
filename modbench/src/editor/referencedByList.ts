import * as vscode from 'vscode';
import type { Log } from '../ports/log';
import type { MEditClient, PluginAddress, ReferenceResult } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { ErrorNode } from '../drivingLib/errorNode';
import type { RecordArgument } from '../drivingLib/recordArgument';
import { recordLabel } from '../wire/recordLabel';
import { isKeyArgs, type CopyValueAdapter } from '../drivingLib/copyValue';
import { REFERENCES_VIEW_ID } from './referencesView';
import { failureReason, isReadFailed, localFailure } from '../wire/readFailed';

function openCommand(row: { readonly argument: RecordArgument }): vscode.Command {
  return { command: 'modbench.record.open', title: 'Open Record', arguments: [{ argument: row.argument, row }] };
}

/** One plugin's copy of a referrer, with the fields that hold the reference. */
export class ReferencedByHolderNode extends vscode.TreeItem {
  readonly argument: RecordArgument;
  readonly plugin: PluginAddress;
  /** What confirmations call the record this copy holds. */
  readonly name: string;
  readonly copyText: string;

  constructor(
    list: string,
    formKey: string,
    editorId: string | undefined,
    address: PluginAddress,
    fieldPaths: readonly string[],
  ) {
    super(address.name, vscode.TreeItemCollapsibleState.None);
    this.plugin = address;
    this.name = editorId ?? formKey;
    this.copyText = recordLabel(editorId, formKey);
    this.argument = { kind: 'record', plugin: address, formKey };
    this.id = JSON.stringify([list, formKey, address.origin, address.name]);
    this.description = fieldPaths.join(', ');
    this.contextValue = 'referencedByHolder';
    this.command = openCommand(this);
  }
}

class ReferencedByReferrerNode extends vscode.TreeItem {
  readonly copyText: string;
  readonly argument: RecordArgument;

  readonly name: string;

  constructor(
    list: string,
    readonly formKey: string,
    editorId: string | undefined,
    readonly recordTypeName: string,
    readonly holders: readonly ReferencedByHolderNode[],
  ) {
    super(editorId ?? formKey, vscode.TreeItemCollapsibleState.Collapsed);
    this.name = editorId ?? formKey;
    this.argument = { kind: 'record', formKey };
    this.copyText = recordLabel(editorId, formKey);
    // The list is in the id so each list starts collapsed.
    this.id = JSON.stringify([list, formKey]);
    this.description = holders.length > 1 ? `${recordTypeName} · ${holders.length} plugins` : recordTypeName;
    this.tooltip = [this.copyText, recordTypeName, holders.map(h => h.plugin.name).join(', ')].join('\n');
    this.contextValue = 'referencedByReferrer';
    this.command = openCommand(this);
  }
}

export type ReferencedByRow = ReferencedByReferrerNode | ReferencedByHolderNode;

type ReferencedByTreeNode = ReferencedByRow | ErrorNode;

const isReferrer = (node: unknown): node is ReferencedByReferrerNode => node instanceof ReferencedByReferrerNode;

const isReferencedByRow = (node: unknown): node is ReferencedByRow => isReferrer(node) || node instanceof ReferencedByHolderNode;

/** The row that an open command was handed by a click or Enter on it. */
export const openedRow = (invocation: unknown): ReferencedByRow | undefined => {
  const row: unknown = typeof invocation === 'object' && invocation !== null ? Reflect.get(invocation, 'row') : undefined;
  return isReferencedByRow(row) ? row : undefined;
};

/** Referenced By's own text for copy value, or `undefined` unless the invocation is one of its rows or its view's key. */
export function referencedByCopyValueText(selection: () => readonly unknown[]): CopyValueAdapter['text'] {
  const lines = (rows: readonly ReferencedByRow[]) => rows.map((row) => row.copyText).join('\n');
  return (clicked, allSelected) => {
    if (isKeyArgs(clicked, REFERENCES_VIEW_ID)) return lines(selection().filter(isReferencedByRow));
    if (!isReferencedByRow(clicked)) return undefined;
    const selected = allSelected?.filter(isReferencedByRow) ?? [];
    return lines(selected.length ? selected : [clicked]);
  };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

function referrerNode(list: string, copies: readonly ReferenceResult[]): ReferencedByReferrerNode | undefined {
  const [first] = copies;
  if (!first) return undefined;
  const editorId = first.editorId ?? undefined;
  const holders = groupBy(copies, r => JSON.stringify([r.origin, r.plugin])).flatMap(fields => {
    const [held] = fields;
    return held
      ? [new ReferencedByHolderNode(list, first.formKey, editorId, { name: held.plugin, origin: held.origin }, fields.map(r => r.fieldPath))]
      : [];
  });
  return new ReferencedByReferrerNode(list, first.formKey, editorId, first.recordTypeName, holders);
}

const byTypeThenLabel = (a: ReferencedByReferrerNode, b: ReferencedByReferrerNode): number =>
  a.recordTypeName.localeCompare(b.recordTypeName) || a.name.localeCompare(b.name);

function messageLine(...parts: (string | undefined)[]): string | undefined {
  return parts.filter(part => part !== undefined).join(' ') || undefined;
}

const NO_REFERENCES_MESSAGE = 'No references found.';
const INDEXING_MESSAGE = 'mEdit is still indexing plugins: this list may not be complete.';

class ReferencedByTreeProvider implements vscode.TreeDataProvider<ReferencedByTreeNode> {
  constructor(private readonly roots: readonly ReferencedByTreeNode[]) {}

  getTreeItem(element: ReferencedByTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ReferencedByTreeNode): ReferencedByTreeNode[] {
    if (!element) return [...this.roots];
    return isReferrer(element) ? [...element.holders] : [];
  }
}

export interface ReferencedByList {
  provider: ReferencedByTreeProvider;
  message: string | undefined;
}

export type ReferencedByClient = Pick<MEditClient, 'getReferences' | 'loadOrderStatus'>;

/** What references `target`, read once (editor-referenced-by.md, Asking, story 4); `list` tells this list from every other asked for. */
export async function readReferencedBy(client: ReferencedByClient, log: Log, target: string, list: string): Promise<ReferencedByList> {
  const read = await client.getReferences(target).catch((error: unknown) => localFailure(errorMessage(error)));
  const indexing = client.loadOrderStatus?.conflictsComputed ? undefined : INDEXING_MESSAGE;
  if (isReadFailed(read)) {
    const reason = failureReason(read);
    log.error(`[ReferencedBy] getReferences(${target}) failed: ${reason}`);
    return { provider: new ReferencedByTreeProvider([new ErrorNode(reason)]), message: indexing };
  }
  const referrers = groupBy(read, r => r.formKey).flatMap(copies => referrerNode(list, copies) ?? []).sort(byTypeThenLabel);
  return {
    provider: new ReferencedByTreeProvider(referrers),
    message: messageLine(referrers.length === 0 ? NO_REFERENCES_MESSAGE : undefined, indexing),
  };
}
