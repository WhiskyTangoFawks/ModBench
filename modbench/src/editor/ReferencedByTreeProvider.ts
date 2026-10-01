import * as vscode from 'vscode';
import type { MEditClient, PluginAddress, ReferenceResult } from '../client';
import { errorMessage } from '../ports/errorMessage';

/** One plugin's copy of a referrer, with the fields that hold the reference. */
export class ReferencedByHolderNode extends vscode.TreeItem {
  readonly plugin: string;
  readonly origin: string;

  constructor(
    target: string,
    readonly formKey: string,
    readonly editorId: string | undefined,
    address: PluginAddress,
    fieldPaths: readonly string[],
  ) {
    super(address.name, vscode.TreeItemCollapsibleState.None);
    this.plugin = address.name;
    this.origin = address.origin;
    this.id = JSON.stringify([target, formKey, address.origin, address.name]);
    this.description = fieldPaths.join(', ');
    this.contextValue = 'referencedByHolder';
  }
}

function referrerName(formKey: string, editorId: string | undefined): string {
  return editorId ? `${editorId} [${formKey}]` : formKey;
}

/** One row for a referrer, however many plugins hold the reference. */
export class ReferencedByReferrerNode extends vscode.TreeItem {
  readonly copyText: string;

  constructor(
    target: string,
    readonly formKey: string,
    editorId: string | undefined,
    recordTypeName: string,
    readonly holders: readonly ReferencedByHolderNode[],
  ) {
    super(editorId ?? formKey, vscode.TreeItemCollapsibleState.Collapsed);
    this.copyText = referrerName(formKey, editorId);
    // The target is in the id so a referrer collapses again when the list follows a new record.
    this.id = JSON.stringify([target, formKey]);
    this.description = holders.length > 1 ? `${recordTypeName} · ${holders.length} plugins` : recordTypeName;
    this.tooltip = [this.copyText, recordTypeName, holders.map(h => h.plugin).join(', ')].join('\n');
    this.contextValue = 'referencedByReferrer';
    this.command = {
      command: 'modbench.record.open',
      title: 'Open Record',
      arguments: [{ formKey }],
    };
  }
}

export class EmptyStateNode extends vscode.TreeItem {
  constructor() {
    super('No references found.', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('check');
  }
}

export class ErrorNode extends vscode.TreeItem {
  constructor() {
    super('Failed to load references.', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

/** The view is always visible and retargets on the active record panel, so it needs a row for
 *  having no record at all. */
export class NoActiveRecordNode extends vscode.TreeItem {
  constructor() {
    super('Open a record to see what references it.', vscode.TreeItemCollapsibleState.None);
  }
}

export type ReferencedByTreeNode =
  | ReferencedByReferrerNode | ReferencedByHolderNode | EmptyStateNode | ErrorNode | NoActiveRecordNode;

/** One line per selected referrer. A row beneath a referrer adds nothing. */
export function referencedByCopyText(nodes: readonly ReferencedByTreeNode[]): string {
  return nodes
    .filter((n): n is ReferencedByReferrerNode => n instanceof ReferencedByReferrerNode)
    .map(n => n.copyText)
    .join('\n');
}

export const REFERENCED_BY_VIEW = 'modbench.referencedByTree';

/** Whether every selected row is one plugin's copy of a referrer, the rows copy and delete act on. */
export function allHolders(selection: readonly unknown[]): boolean {
  return selection.length > 0 && selection.every(n => n instanceof ReferencedByHolderNode);
}

/** Referenced By's own text for copy value, or `undefined` unless the invocation is a referrer row
 *  or its Ctrl+C, which names the view. */
export function referencedByCopyValueText(
  referencedByTreeView: Pick<vscode.TreeView<ReferencedByTreeNode>, 'selection'>,
  clicked: unknown, allSelected: readonly unknown[] | undefined,
): string | undefined {
  const isReferrer = (n: unknown): n is ReferencedByReferrerNode => n instanceof ReferencedByReferrerNode;
  const fromKey = typeof clicked === 'object' && clicked !== null && Reflect.get(clicked, 'view') === REFERENCED_BY_VIEW;
  if (!isReferrer(clicked) && !fromKey) return undefined;
  const selected = allSelected?.filter(isReferrer) ?? [];
  if (selected.length) return referencedByCopyText(selected);
  if (referencedByTreeView.selection.length) return referencedByCopyText(referencedByTreeView.selection);
  return referencedByCopyText(isReferrer(clicked) ? [clicked] : []);
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

function referrerNode(target: string, copies: readonly ReferenceResult[]): ReferencedByReferrerNode | undefined {
  const [first] = copies;
  if (!first) return undefined;
  const editorId = first.editorId ?? undefined;
  const holders = groupBy(copies, r => JSON.stringify([r.origin, r.plugin])).flatMap(fields => {
    const [held] = fields;
    return held
      ? [new ReferencedByHolderNode(target, first.formKey, editorId, { name: held.plugin, origin: held.origin }, fields.map(r => r.fieldPath))]
      : [];
  });
  return new ReferencedByReferrerNode(target, first.formKey, editorId, first.recordTypeName, holders);
}

/** A Panel view that follows the active record editor rather than an explicit command, so its
 *  target is set by `showFor`, never by an invocation. */
export class ReferencedByTreeProvider implements vscode.TreeDataProvider<ReferencedByTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ReferencedByTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private target: string | undefined;

  private readonly log: (msg: string) => void;
  private readonly onCountChanged: (count: number | undefined) => void;

  constructor(
    private readonly client: MEditClient,
    log?: (msg: string) => void,
    // Feeds the view title's "Referenced By (N)" badge (xEdit's `Referenced By (%d)` caption).
    // `undefined` is "no known count" — no active record, or a failed fetch — so neither
    // renders a misleading "(0)".
    onCountChanged?: (count: number | undefined) => void,
  ) {
    this.log = log ?? (() => {});
    this.onCountChanged = onCountChanged ?? (() => {});
  }

  showFor(formKey: string | undefined): void {
    this.target = formKey;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ReferencedByTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ReferencedByTreeNode): Promise<ReferencedByTreeNode[]> {
    if (element instanceof ReferencedByReferrerNode) return [...element.holders];
    if (element) return [];
    return this.rootNodes();
  }

  private async rootNodes(): Promise<ReferencedByTreeNode[]> {
    if (!this.target) {
      this.onCountChanged(undefined);
      return [new NoActiveRecordNode()];
    }
    const target = this.target;
    let references: ReferenceResult[];
    try {
      references = await this.client.getReferences(target);
    } catch (e) {
      this.log(`[ReferencedByTreeProvider] getReferences(${target}) failed: ${errorMessage(e)}`);
      this.onCountChanged(undefined);
      return [new ErrorNode()];
    }
    if (references.length === 0) {
      this.onCountChanged(0);
      return [new EmptyStateNode()];
    }

    const referrers = groupBy(references, r => r.formKey).flatMap(copies => referrerNode(target, copies) ?? []);
    this.onCountChanged(referrers.length);
    return referrers;
  }
}
