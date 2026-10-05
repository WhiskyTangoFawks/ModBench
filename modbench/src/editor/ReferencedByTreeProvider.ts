import * as vscode from 'vscode';
import type { MEditClient, PluginAddress, ReferenceResult } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { trackLoadOrderStatus } from './loadOrderStatusTracker';
import { recordTitle } from './recordTitle';

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

  readonly name: string;

  constructor(
    target: string,
    readonly formKey: string,
    editorId: string | undefined,
    readonly recordTypeName: string,
    readonly holders: readonly ReferencedByHolderNode[],
  ) {
    super(editorId ?? formKey, vscode.TreeItemCollapsibleState.Collapsed);
    this.name = editorId ?? formKey;
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

export class ErrorNode extends vscode.TreeItem {
  constructor(reason: string) {
    super(`Failed to load: ${reason}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = reason;
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

export type ReferencedByTreeNode = ReferencedByReferrerNode | ReferencedByHolderNode | ErrorNode;

export type ReferrerDirection = 'ascending' | 'descending';

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

type ReferencedByClient =
  Pick<MEditClient, 'getReferences' | 'getComparison' | 'onNotification' | 'onStatusChanged' | 'onReconnected'>;

function messageLine(...parts: (string | undefined)[]): string | undefined {
  return parts.filter(part => part !== undefined).join(' ') || undefined;
}

const NO_RECORD_MESSAGE = 'Open a record to see what references it.';
const NO_REFERENCES_MESSAGE = 'No references found.';
const INDEXING_MESSAGE = 'mEdit is still indexing plugins: this list may not be complete.';

/** A Panel view that follows the active record editor rather than an explicit command, so its
 *  target is set by `showFor`, never by an invocation. */
export class ReferencedByTreeProvider implements vscode.TreeDataProvider<ReferencedByTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ReferencedByTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _onDidChangeView = new vscode.EventEmitter<void>();
  /** Fires when what the view says about itself changes: its count, its record, its message. */
  readonly onDidChangeView = this._onDidChangeView.event;

  private target: string | undefined;
  private name: string | undefined;
  private referrers: readonly ReferencedByReferrerNode[] | undefined;
  private failure: string | undefined;
  private reading: Promise<void> | undefined;
  private generation = 0;
  private term = '';
  private direction: ReferrerDirection = 'ascending';
  private readonly indexed: ReturnType<typeof trackLoadOrderStatus>;
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly client: ReferencedByClient,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.indexed = trackLoadOrderStatus(client, undefined, () => this.reread());
    this.unsubscribe = [
      client.onNotification('rows-changed', () => this.reread()),
      client.onNotification('plugin-changed', () => this.reread()),
      client.onReconnected(() => this.reread()),
    ];
  }

  dispose(): void {
    this.indexed.dispose();
    for (const off of this.unsubscribe) off();
  }

  showFor(formKey: string | undefined): void {
    if (formKey !== this.target) {
      this.target = formKey;
      this.name = undefined;
      this.referrers = undefined;
      this.failure = undefined;
    }
    this.reread();
  }

  setFilter(text: string): void {
    this.term = text;
    this._onDidChangeTreeData.fire(undefined);
  }

  setDirection(direction: ReferrerDirection): void {
    this.direction = direction;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** The count of every record that references the target, whatever the filter hides. Undefined
   *  while it is not known, so a title never shows a zero it has not confirmed. */
  count(): number | undefined {
    return this.referrers?.length;
  }

  recordName(): string | undefined {
    return this.name;
  }

  viewMessage(): string | undefined {
    if (this.target === undefined) return NO_RECORD_MESSAGE;
    const empty = this.referrers?.length === 0 ? NO_REFERENCES_MESSAGE : undefined;
    return messageLine(empty, this.standingMessage());
  }

  /** What stays on the message line beside the filter's no-match message. */
  standingMessage(): string | undefined {
    if (this.target === undefined) return undefined;
    const lastGoodRead = this.referrers !== undefined && this.failure !== undefined
      ? `Showing the last good read: ${this.failure}` : undefined;
    return messageLine(this.indexed.current() ? undefined : INDEXING_MESSAGE, lastGoodRead);
  }

  /** False only when the term hides every referrer there is, which is when no match is the news. */
  async hasRows(): Promise<boolean> {
    await this.read();
    return this.referrers === undefined || this.referrers.length === 0 || this.visibleReferrers().length > 0;
  }

  getTreeItem(element: ReferencedByTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ReferencedByTreeNode): Promise<ReferencedByTreeNode[]> {
    if (element instanceof ReferencedByReferrerNode) return [...element.holders];
    if (element) return [];
    if (this.target === undefined) return [];
    await this.read();
    if (this.referrers === undefined) return this.failure === undefined ? [] : [new ErrorNode(this.failure)];
    return this.visibleReferrers();
  }

  private reread(): void {
    this.generation++;
    this.reading = undefined;
    this._onDidChangeTreeData.fire(undefined);
    this._onDidChangeView.fire();
  }

  private read(): Promise<void> {
    this.reading ??= this.load();
    return this.reading;
  }

  private async load(): Promise<void> {
    const target = this.target;
    if (target === undefined) return;
    const mine = this.generation;
    const [references, comparison] = await Promise.allSettled([this.client.getReferences(target), this.client.getComparison(target)]);
    if (mine !== this.generation) return;
    this.name = recordTitle(target, comparison.status === 'fulfilled' ? comparison.value?.overrides : undefined);
    if (references.status === 'fulfilled') {
      this.referrers = groupBy(references.value, r => r.formKey).flatMap(copies => referrerNode(target, copies) ?? []);
      this.failure = undefined;
    } else {
      this.failure = errorMessage(references.reason);
      this.log(`[ReferencedByTreeProvider] getReferences(${target}) failed: ${this.failure}`);
    }
    this._onDidChangeView.fire();
  }

  private visibleReferrers(): ReferencedByReferrerNode[] {
    const term = this.term.toLowerCase();
    const sign = this.direction === 'ascending' ? 1 : -1;
    return (this.referrers ?? [])
      .filter(r => r.name.toLowerCase().includes(term))
      .sort((a, b) => sign * (a.recordTypeName.localeCompare(b.recordTypeName) || a.name.localeCompare(b.name)));
  }
}
