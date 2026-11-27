import * as vscode from 'vscode';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import { commandLink } from '../drivingLib/quickFixes';
import type { PluginAddress } from '../client';
import type { NamedPlugins } from './pluginAddress';
import { exactPluginAddressKey } from '../wire/pluginAddress';
import { STATUS_SEVERITY, type PluginPlace, type PluginProblem, type StatusKind } from './pluginFacts';
import type { RuleFileDiagnostic } from '../sortingRules/ruleFileDiagnostics';

/** Targets the plugin binary itself, which is where a malformed plugin's diagnoses, a change
 *  outside Modbench and a failed read's diagnosis all live. One call answers for the plugins `named`,
 *  or for the whole load order. */
export function publishPluginProblems<T extends PluginProblem>(
  collection: vscode.DiagnosticCollection,
  pluginFile: (plugin: PluginAddress) => string | undefined,
  entries: readonly T[],
  severity: vscode.DiagnosticSeverity,
  codeOf?: (plugin: PluginAddress, entry: T) => vscode.Diagnostic['code'],
  named?: NamedPlugins,
): void {
  const setAt = clearOf(collection, named);
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const r of entries) {
    const plugin = { name: r.plugin, origin: r.origin };
    // A plugin that vanished between scan and publish has no file to point at.
    const fsPath = pluginFile(plugin);
    if (fsPath === undefined) continue;
    setAt.set(exactPluginAddressKey(plugin), fsPath);
    const list = byUri.get(fsPath) ?? [];
    const diagnostic = modbenchDiagnostic(new vscode.Range(0, 0, 0, 0), r.text, severity);
    if (codeOf !== undefined) diagnostic.code = codeOf(plugin, r);
    list.push(diagnostic);
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
}

// Where each plugin's diagnostics stand in each collection, so a plugin that has no file now is cleared there too.
const standing = new WeakMap<vscode.DiagnosticCollection, Map<string, string>>();

// Clears the diagnostics of the plugins `named`, or every plugin's, and answers where the rest stand.
function clearOf(collection: vscode.DiagnosticCollection, named: NamedPlugins): Map<string, string> {
  const setAt = (named && standing.get(collection)) ?? new Map<string, string>();
  standing.set(collection, setAt);
  if (named === undefined) collection.clear();
  for (const key of named?.map(exactPluginAddressKey) ?? []) {
    const fsPath = setAt.get(key);
    if (fsPath !== undefined) collection.delete(vscode.Uri.file(fsPath));
    setAt.delete(key);
  }
  return setAt;
}

const SEVERITY = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information } as const;

/** A status's problem, at the severity its row shows. */
export const problemSeverity = (kind: StatusKind): vscode.DiagnosticSeverity => SEVERITY[STATUS_SEVERITY[kind]];

/** The sorting rule files' own lines, each at its level. */
export function publishRuleFileDiagnostics(collection: vscode.DiagnosticCollection, entries: readonly RuleFileDiagnostic[]): void {
  collection.clear();
  const byPath = new Map<string, vscode.Diagnostic[]>();
  for (const { path, line, level, text } of entries) {
    byPath.set(path, [...byPath.get(path) ?? [], modbenchDiagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), text, SEVERITY[level])]);
  }
  for (const [path, list] of byPath) collection.set(vscode.Uri.file(path), list);
}

/** source.md, Decompile and repair, story 1: a Malformed entry's link in the Problems panel, which fires the
 *  gesture on its plugin. Only a mod can hold a plugin's source, as on the row's menu. */
export const decompileAndRepairLink = (plugin: PluginAddress, place: PluginPlace | undefined): vscode.Diagnostic['code'] =>
  place === 'inSourceMod' || place === 'inNonSourceMod'
    ? commandLink('decompile and repair', 'modbench.plugin.decompileAndRepair', [plugin])
    : undefined;

/** source.md, Decompile: a Plugin source unreadable entry's link in the Problems panel, which fires the gesture on its
 *  plugin. Offered only where decompile writes the plugin source. */
export const decompileLink = (plugin: PluginAddress, decompileRepairs: boolean): vscode.Diagnostic['code'] =>
  decompileRepairs
    ? commandLink('decompile', 'modbench.plugin.decompile', [plugin])
    : undefined;
