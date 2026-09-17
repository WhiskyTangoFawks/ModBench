import * as vscode from 'vscode';
import type { MEditClient, ReferenceResult } from '../client';
import { errorMessage } from '../ports/errorMessage';

/** Rows sharing a FormKey collapse into one node, so one referencer reads as one thing rather
 *  than as several. */
export class ReferencedByGroupNode extends vscode.TreeItem {
  // `this.label` is `string | vscode.TreeItemLabel` on the base class; the constructor below
  // always passes the template-literal string, so this is that same string, kept typed.
  readonly displayLabel: string;

  constructor(
    readonly formKey: string,
    readonly results: ReferenceResult[],
  ) {
    const first = results.at(0);
    const recordType = first?.recordType ?? '';
    const recordLabel = first?.editorId ?? formKey;
    const displayLabel = `${recordType} / ${recordLabel}`;
    super(displayLabel, vscode.TreeItemCollapsibleState.Collapsed);
    this.displayLabel = displayLabel;
    if (results.length > 1) this.description = `${results.length} plugins`;
    this.contextValue = 'referencedByGroup';
    this.iconPath = new vscode.ThemeIcon('references');
    this.command = {
      command: 'modbench.openEditor',
      title: 'Open Record',
      arguments: [{ formKey, label: recordLabel }],
    };
  }
}

/** Informational, not a navigation target — hence no `command`. */
export class ReferencedByFieldNode extends vscode.TreeItem {
  constructor(result: ReferenceResult) {
    super(`${result.plugin} · ${result.fieldPath}`, vscode.TreeItemCollapsibleState.None);
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
  | ReferencedByGroupNode | ReferencedByFieldNode | EmptyStateNode | ErrorNode | NoActiveRecordNode;

/** One line per selected *referrer*. A field row is detail under a group, never independently
 *  copyable, so it contributes nothing — a field-rows-only selection copies empty text. */
export function referencedByCopyText(nodes: readonly ReferencedByTreeNode[]): string {
  return nodes
    .filter((n): n is ReferencedByGroupNode => n instanceof ReferencedByGroupNode)
    .map(n => n.displayLabel)
    .join('\n');
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
    if (element instanceof ReferencedByGroupNode) {
      return element.results.map(r => new ReferencedByFieldNode(r));
    }
    if (element) return [];
    return this.rootNodes();
  }

  private async rootNodes(): Promise<ReferencedByTreeNode[]> {
    if (!this.target) {
      this.onCountChanged(undefined);
      return [new NoActiveRecordNode()];
    }
    const formKey = this.target;
    let references: ReferenceResult[];
    try {
      references = await this.client.getReferences(formKey);
    } catch (e) {
      this.log(`[ReferencedByTreeProvider] getReferences(${formKey}) failed: ${errorMessage(e)}`);
      this.onCountChanged(undefined);
      return [new ErrorNode()];
    }
    if (references.length === 0) {
      this.onCountChanged(0);
      return [new EmptyStateNode()];
    }

    const groups = new Map<string, ReferenceResult[]>();
    for (const r of references) {
      const key = r.formKey;
      const existing = groups.get(key);
      if (existing) existing.push(r);
      else groups.set(key, [r]);
    }
    this.onCountChanged(groups.size);
    return Array.from(groups.entries()).map(([formKey, results]) => new ReferencedByGroupNode(formKey, results));
  }
}
