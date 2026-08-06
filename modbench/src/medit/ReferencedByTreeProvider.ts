import * as vscode from 'vscode';
import type { ApiClient } from './ApiClient';
import type { components } from './generated/api';

type ReferenceResult = components['schemas']['ReferenceResult'];

/** One referencing record — one or more `ReferenceResult` rows sharing a FormKey, collapsed
 *  into a single group (spec: "one referencer reads as one thing rather than as several").
 *  Label is `{RecordType} / {EditorID ?? FormKey}`; the plugin count is shown only when more
 *  than one plugin holds the reference. Left-click (the node's `command`) opens the record;
 *  right-click (`referencedByGroup` contextValue) offers Open / Open to the Side. */
export class ReferencedByGroupNode extends vscode.TreeItem {
  constructor(
    readonly formKey: string,
    readonly results: ReferenceResult[],
  ) {
    const first = results[0];
    const recordType = first?.recordType ?? '';
    const recordLabel = first?.editorId ?? formKey;
    super(`${recordType} / ${recordLabel}`, vscode.TreeItemCollapsibleState.Collapsed);
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

/** A single holding plugin + field path under a group — informational, not a navigation
 *  target (spec: "Expanded child rows show each holding plugin and field path
 *  (informational, not clickable)"). No `command`. */
export class ReferencedByFieldNode extends vscode.TreeItem {
  constructor(result: ReferenceResult) {
    super(`${result.plugin ?? ''} · ${result.fieldPath ?? ''}`, vscode.TreeItemCollapsibleState.None);
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

/** Shown before the first `showFor` of the session — the view is contributed but hidden
 *  (`modbench.referencedByShown`) until then, so in practice nothing renders this node, but
 *  `getChildren` still needs a defined answer if VS Code queries it early. */
export class NotShownNode extends vscode.TreeItem {
  constructor() {
    super('Right-click a record and choose "Show Referenced By".', vscode.TreeItemCollapsibleState.None);
  }
}

export type ReferencedByTreeNode =
  | ReferencedByGroupNode | ReferencedByFieldNode | EmptyStateNode | ErrorNode | NotShownNode;

/** Backs the "Referenced By" tree — an on-demand, per-record relationship query, same shape as
 *  VS Code's own Call Hierarchy / Type Hierarchy: hidden until first invoked (see extension.ts's
 *  `modbench.showReferencedBy`), then retargeted in place by `showFor` on every subsequent
 *  invocation rather than recreated. Root data comes from `GET /records/{formKey}/references`
 *  (the generated `ApiClient` — no raw `fetch()`), grouped by referencing FormKey. */
export class ReferencedByTreeProvider implements vscode.TreeDataProvider<ReferencedByTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ReferencedByTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private target: { formKey: string; editorId: string | null | undefined } | undefined;

  private readonly log: (msg: string) => void;

  constructor(private readonly client: ApiClient, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  /** Retargets the tree at a different record and refreshes — called every time
   *  `modbench.showReferencedBy` runs, including the first. */
  showFor(formKey: string, editorId: string | null | undefined): void {
    this.target = { formKey, editorId };
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
    if (!this.target) return [new NotShownNode()];
    const { formKey } = this.target;
    const res = await this.client.GET('/records/{formKey}/references', { params: { path: { formKey } } });
    if (!res.response.ok || !Array.isArray(res.data)) {
      this.log(`[ReferencedByTreeProvider] /records/${formKey}/references fetch failed (${res.response.status})`);
      return [new ErrorNode()];
    }
    if (res.data.length === 0) return [new EmptyStateNode()];

    const groups = new Map<string, ReferenceResult[]>();
    for (const r of res.data) {
      const key = r.formKey ?? '';
      const existing = groups.get(key);
      if (existing) existing.push(r);
      else groups.set(key, [r]);
    }
    return Array.from(groups.entries()).map(([formKey, results]) => new ReferencedByGroupNode(formKey, results));
  }
}
