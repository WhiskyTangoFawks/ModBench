import { vi } from 'vitest';
import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range, uriFile, uriFrom,
} from '../../test/vscodeMock';
import { recordedWithProgress, progressSteps } from '../../test/recordedProgress';

export const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();

export const registerCommand = vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
  handlers.set(command, handler);
  return { dispose: vi.fn() };
});

export const showQuickPick = vi.fn<
  (items: readonly { label: string; description?: string }[], options?: unknown) =>
    Promise<{ label: string; description?: string }[] | undefined>
>();

export const createQuickPick = vi.fn();

export const executeCommand = vi.fn().mockResolvedValue(undefined);

/** The `vscode` module the source gestures run against; mock it with `vi.mock('vscode', () => vscodeModule())`. */
export const vscodeModule = () => ({
  commands: { registerCommand, executeCommand },
  window: { showQuickPick, createQuickPick, withProgress: recordedWithProgress },
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range,
  Uri: { file: uriFile, from: uriFrom },
});

export const instanceThatReads = {
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
};

export class PluginRowStandIn extends TreeItem {
  readonly kind = 'plugin';
  readonly argument: { kind: 'plugin'; plugin: { name: string; origin: string } };
  constructor(plugin: { name: string; origin: string }) { super(plugin.name); this.argument = { kind: 'plugin', plugin }; }
}

export class ModsRowStandIn extends TreeItem {
  readonly kind = 'mod';
  readonly argument: { kind: 'mod'; name: string };
  constructor(name: string) { super(name); this.argument = { kind: 'mod', name }; }
}
