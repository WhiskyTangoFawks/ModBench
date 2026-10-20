import type * as vscode from 'vscode';

interface ConfigurationChange { affectsConfiguration(section: string): boolean }

export function onSettingChange(
  onDidChange: (listener: (change: ConfigurationChange) => void) => vscode.Disposable, setting: string, listener: () => void,
): vscode.Disposable {
  return onDidChange((change) => {
    if (change.affectsConfiguration(setting)) listener();
  });
}

export function declaredSetting<T>(setting: string, value: T | undefined): T {
  if (value === undefined) throw new Error(`${setting} has no value: package.json declares its default.`);
  return value;
}
