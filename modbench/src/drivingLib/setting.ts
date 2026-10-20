import type * as vscode from 'vscode';

interface ConfigurationChange { affectsConfiguration(section: string): boolean }

export function onSettingChange(
  onDidChange: (listener: (change: ConfigurationChange) => void) => vscode.Disposable, settings: string | readonly string[], listener: () => void,
): vscode.Disposable {
  const watched = [settings].flat();
  return onDidChange((change) => {
    if (watched.some((setting) => change.affectsConfiguration(setting))) listener();
  });
}
