import * as vscode from 'vscode';

export const scriptEnvironmentFileOf = (instanceRoot: string) => (): string | undefined =>
  vscode.workspace.getConfiguration('python', vscode.Uri.file(instanceRoot)).get<string>('envFile');
