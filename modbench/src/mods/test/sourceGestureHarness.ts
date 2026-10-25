import { vi } from 'vitest';
import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range, uriFile, uriFrom,
} from '../../test/vscodeMock';
import { recordedWithProgress } from '../../test/recordedProgress';

export const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();

const registerCommand = vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
  handlers.set(command, handler);
  return { dispose: vi.fn() };
});

export const showQuickPick = vi.fn<
  (items: readonly { label: string; description?: string }[], options?: unknown) =>
    Promise<{ label: string; description?: string }[] | undefined>
>();

export const createQuickPick = vi.fn();

const executeCommand = vi.fn().mockResolvedValue(undefined);

/** The `vscode` module the source gestures run against; mock it with `vi.mock('vscode', () => vscodeModule())`. */
export const vscodeModule = () => ({
  commands: { registerCommand, executeCommand },
  window: { showQuickPick, createQuickPick, withProgress: recordedWithProgress },
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range,
  Uri: { file: uriFile, from: uriFrom },
});

export class PluginRowStandIn extends TreeItem {
  readonly kind = 'plugin';
  readonly argument: { kind: 'plugin'; plugin: { name: string; origin: string } };
  constructor(plugin: { name: string; origin: string }) { super(plugin.name); this.argument = { kind: 'plugin', plugin }; }
}
