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

/** Shown whenever no record editor is active — before the first record is opened this load order,
 *  or after the last one closes (#282: the view is always visible now, retargeting on the active
 *  record panel instead of being hidden until an explicit "Show Referenced By" invocation). */
export class NoActiveRecordNode extends vscode.TreeItem {
  constructor() {
    super('Open a record to see what references it.', vscode.TreeItemCollapsibleState.None);
  }
}

export type ReferencedByTreeNode =
  | ReferencedByGroupNode | ReferencedByFieldNode | EmptyStateNode | ErrorNode | NoActiveRecordNode;

/** The `modbench.referencedByTree.copy` command's text (#282) — one line per selected
 *  *referrer*, matching its own displayed label exactly. Field rows are detail under a group,
 *  not independently copyable, so a field row in the selection contributes nothing; a selection
 *  containing only field rows copies empty text rather than falling back to them. */
export function referencedByCopyText(nodes: readonly ReferencedByTreeNode[]): string {
  return nodes
    .filter((n): n is ReferencedByGroupNode => n instanceof ReferencedByGroupNode)
    // ReferencedByGroupNode always constructs `label` as a template-literal string (never
    // TreeItemLabel), so this cast is safe — unlike a generic TreeItem it never carries highlights.
    .map(n => n.label as string)
    .join('\n');
}

/** Backs the "Referenced By" tree — a Panel view that follows the active record editor (#282),
 *  retargeted by `showFor` on every active-record change (`ActiveRecordTracker`) rather than by
 *  an explicit command. Root data comes from `GET /records/{formKey}/references` (the generated
 *  `ApiClient` — no raw `fetch()`), grouped by referencing FormKey. */
export class ReferencedByTreeProvider implements vscode.TreeDataProvider<ReferencedByTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ReferencedByTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private target: string | undefined;

  private readonly log: (msg: string) => void;
  private readonly onCountChanged: (count: number | undefined) => void;

  constructor(
    private readonly client: ApiClient,
    log?: (msg: string) => void,
    // #282: the view title's "Referenced By (N)" badge (xEdit's `Referenced By (%d)` caption) —
    // a callback fired from rootNodes()
    // whenever it resolves. `undefined` means "no known count" (no active record, or a failed
    // fetch) so extension.ts never renders a misleading "(0)" for either — only a genuine
    // zero-referrer result reports 0.
    onCountChanged?: (count: number | undefined) => void,
  ) {
    this.log = log ?? (() => {});
    this.onCountChanged = onCountChanged ?? (() => {});
  }

  /** Retargets the tree at a different record (or `undefined` — no record editor is active) and
   *  refreshes. Called by the active-record tracker on every active-panel/record change, not by
   *  an explicit command (#282). */
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
    const res = await this.client.GET('/records/{formKey}/references', { params: { path: { formKey } } });
    if (!res.response.ok || !Array.isArray(res.data)) {
      this.log(`[ReferencedByTreeProvider] /records/${formKey}/references fetch failed (${res.response.status})`);
      this.onCountChanged(undefined);
      return [new ErrorNode()];
    }
    if (res.data.length === 0) {
      this.onCountChanged(0);
      return [new EmptyStateNode()];
    }

    const groups = new Map<string, ReferenceResult[]>();
    for (const r of res.data) {
      const key = r.formKey ?? '';
      const existing = groups.get(key);
      if (existing) existing.push(r);
      else groups.set(key, [r]);
    }
    this.onCountChanged(groups.size);
    return Array.from(groups.entries()).map(([formKey, results]) => new ReferencedByGroupNode(formKey, results));
  }
}
