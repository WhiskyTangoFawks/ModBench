import type * as vscode from 'vscode';

/** The slice of VS Code's workspace the Mods view's settings are read through. */
export interface WorkspaceSettings {
  getConfiguration(): { get(key: string): unknown };
  readonly onDidChangeConfiguration: vscode.Event<{ affectsConfiguration(section: string): boolean }>;
}
