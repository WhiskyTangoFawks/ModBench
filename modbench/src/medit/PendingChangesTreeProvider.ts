import * as vscode from 'vscode';
import type { ApiClient } from './ApiClient';
import type { components } from './generated/api';

type ChangeGroup = components['schemas']['ChangeGroup'];
type PendingChange = components['schemas']['PendingChange'];

/** Compact display of a pending value (old/new). Complex fields render as JSON. */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return v.toString();
  return JSON.stringify(v);
}

/** A single pending change — a top-level group-of-one (`pendingGroup`) or a member
 *  of a multi-member group (`pendingGroupMember`). The record is shown by FormKey
 *  until #141 delivers FormKey → EditorID resolution over the change response. */
export class PendingLeafNode extends vscode.TreeItem {
  readonly changeId: string;
  readonly formKey: string;
  readonly plugin: string;
  parent?: PendingGroupNode;

  /** Member change id keying save/revert on this node's whole component (ADR-0028).
   *  A top-level singleton is its own component, so its change id names it. */
  get componentId(): string { return this.changeId; }

  constructor(change: PendingChange, contextValue: 'pendingGroup' | 'pendingGroupMember') {
    const recordType = change.recordType ?? '';
    const formKey = change.formKey ?? '';
    const fieldPath = change.fieldPath ?? '';
    super(`${recordType} / ${formKey} · ${fieldPath}`, vscode.TreeItemCollapsibleState.None);
    this.changeId = change.id ?? '';
    this.formKey = formKey;
    this.plugin = change.plugin ?? '';
    this.description = `${formatValue(change.oldValue)} → ${formatValue(change.newValue)} · ${this.plugin}`;
    this.contextValue = contextValue;
    this.command = {
      command: 'modbench.openEditor',
      title: 'Open Record',
      arguments: [{ formKey, label: formKey }],
    };
  }
}

/** A multi-member ChangeGroup: an expandable header whose children are its member edits.
 *  Titled `{operation} {description}`, described by its scope. A group has no id of its
 *  own (ADR-0028); `groupId` is a member change id that names the whole component. */
export class PendingGroupNode extends vscode.TreeItem {
  readonly groupId: string;
  readonly members: PendingChange[];

  /** Member change id keying save/revert on the whole component (ADR-0028). */
  get componentId(): string { return this.groupId; }

  constructor(group: ChangeGroup, members: PendingChange[]) {
    const op = group.operation ?? '';
    super(group.description ? `${op} ${group.description}` : op, vscode.TreeItemCollapsibleState.Collapsed);
    this.groupId = group.id ?? '';
    this.members = members;
    const records = new Set(members.map(m => m.formKey ?? '')).size;
    this.description = `${group.changeCount ?? members.length} edits · ${records} records · ${group.pluginCount ?? 0} plugins`;
    this.iconPath = new vscode.ThemeIcon('link');
    this.contextValue = 'pendingGroup';
  }
}

export class EmptyStateNode extends vscode.TreeItem {
  constructor() {
    super('No pending changes.', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('check');
  }
}

export class ErrorNode extends vscode.TreeItem {
  constructor() {
    super('Failed to load pending changes.', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

export type PendingTreeNode = PendingLeafNode | PendingGroupNode | EmptyStateNode | ErrorNode;

export class PendingChangesTreeProvider implements vscode.TreeDataProvider<PendingTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PendingTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly log: (msg: string) => void;

  constructor(private readonly client: ApiClient, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PendingTreeNode): vscode.TreeItem {
    return element;
  }

  getParent(element: PendingTreeNode): PendingTreeNode | undefined {
    return element instanceof PendingLeafNode ? element.parent : undefined;
  }

  async getChildren(element?: PendingTreeNode): Promise<PendingTreeNode[]> {
    if (element instanceof PendingGroupNode) {
      return element.members.map(m => {
        const node = new PendingLeafNode(m, 'pendingGroupMember');
        node.parent = element;
        return node;
      });
    }
    if (element) return [];
    return this.rootNodes();
  }

  private async rootNodes(): Promise<PendingTreeNode[]> {
    const groupsRes = await this.client.GET('/change-groups', {});
    if (!groupsRes.response.ok || !Array.isArray(groupsRes.data)) {
      this.log(`[PendingChangesTreeProvider] /change-groups fetch failed (${groupsRes.response.status})`);
      return [new ErrorNode()];
    }
    const groups = groupsRes.data;
    if (groups.length === 0) return [new EmptyStateNode()];

    const changesRes = await this.client.GET('/changes', {});
    if (!changesRes.response.ok || !Array.isArray(changesRes.data)) {
      this.log(`[PendingChangesTreeProvider] /changes fetch failed (${changesRes.response.status})`);
      return [new ErrorNode()];
    }
    const byId = new Map((changesRes.data as PendingChange[]).map(c => [c.id, c]));

    const groupNodes: PendingGroupNode[] = [];
    const leafNodes: PendingLeafNode[] = [];
    for (const g of groups) {
      if ((g.changeCount ?? 0) > 1) {
        // group.id is a member change id (ADR-0028); it selects the whole component.
        groupNodes.push(new PendingGroupNode(g, await this.fetchMembers(g.id)));
      } else {
        // A singleton group's id is its one member's id (min of one).
        const change = byId.get(g.id);
        if (change) leafNodes.push(new PendingLeafNode(change, 'pendingGroup'));
      }
    }

    // Multi-member groups first (the rare thing this view exists for); then single
    // edits by plugin, then record, so one record's edits are contiguous (ADR-0029).
    leafNodes.sort((a, b) =>
      a.plugin.localeCompare(b.plugin, undefined, { sensitivity: 'accent' }) ||
      a.formKey.localeCompare(b.formKey, undefined, { sensitivity: 'accent' }));

    return [...groupNodes, ...leafNodes];
  }

  private async fetchMembers(groupId: string | undefined): Promise<PendingChange[]> {
    const res = await this.client.GET('/changes', { params: { query: { groupId } } });
    return res.response.ok && Array.isArray(res.data) ? (res.data) : [];
  }
}
