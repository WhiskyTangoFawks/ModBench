import * as vscode from 'vscode';
import type { PluginAddress } from '../client';
import type { PluginEntry } from '../instanceLoader/instance';
import { blankIcon } from '../drivingLib/blankIcon';
import type { PluginArgument } from '../drivingLib/argument';
import { exactPluginAddressKey } from '../wire/pluginAddress';
import { headerFormKeyOf } from '../wire/headerFormKey';
import { rowResourceUri } from './recordResourceUri';
import type { RecordBrowserNode } from './RecordBrowser';

// plugins.md, A row, Identity: VS Code keeps expansion and selection across a rebuild by it, and
// refuses two rows that share one.
export function rowIdentity(kind: string, plugin: PluginAddress, formKey?: string): string {
  return [kind, exactPluginAddressKey(plugin), ...(formKey === undefined ? [] : [formKey])].join(':');
}

function openHeaderCommand(header: PluginAddress): vscode.Command {
  return { command: 'modbench.record.open', title: 'Open Record', arguments: [{ argument: { kind: 'record', formKey: headerFormKeyOf(header), plugin: header } }] };
}

export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  readonly argument: PluginArgument;
  constructor(
    public readonly plugin: PluginEntry,
    /** Which plugin of the name this row stands for (ADR-0012), the join key for every fact. */
    public readonly origin: string,
  ) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.argument = { kind: 'plugin', plugin: { name: plugin.name, origin } };
    this.id = rowIdentity(this.kind, { name: plugin.name, origin });
    this.resourceUri = rowResourceUri({ name: plugin.name, origin });
    this.iconPath = blankIcon();
    this.contextValue = `plugin ${plugin.enabled ? 'enabled' : 'disabled'}`;
    // xEdit parity: selecting a plugin node shows its File Header, with no separate affordance.
    // plugins.md, Menus and keys, story 2: the game loads no disabled plugin's records, so a click
    // on its row only selects it.
    if (plugin.enabled) this.command = openHeaderCommand({ name: plugin.name, origin });
    this.checkboxState = plugin.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** A lock stands in for the reference tool's checkbox (plugins.md, A plugin the game loads with
 *  no line). */
export class ImplicitMasterNode extends vscode.TreeItem {
  readonly kind = 'implicitMaster' as const;
  readonly argument: PluginArgument;
  declare resourceUri: vscode.Uri;
  constructor(public readonly name: string, public readonly origin: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.argument = { kind: 'plugin', plugin: { name, origin } };
    this.id = rowIdentity(this.kind, { name, origin });
    this.resourceUri = rowResourceUri({ name, origin });
    this.contextValue = 'pluginImplicit';
    this.iconPath = new vscode.ThemeIcon('lock');
    // plugins.md, A plugin the game loads with no line: the reference tool's one sentence alone —
    // the label already shows the greyed file name, so the tooltip does not repeat it.
    this.tooltip = "This plugin can't be disabled or moved (enforced by the game).";
    this.command = openHeaderCommand({ name, origin });
  }
}

export type PluginListNode = PluginNode | ImplicitMasterNode;

/** What this tree hands VS Code: a load-order row, or one of the record browser's nodes under
 *  it. */
export type PluginsTreeNode = PluginListNode | RecordBrowserNode;
