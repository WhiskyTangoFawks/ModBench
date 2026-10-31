import * as vscode from 'vscode';
import { ToolboxProvider } from './ToolboxProvider';
import { linesOf } from '../drivingLib/messageLine';
import { TOOLBOX_VIEW } from './toolboxCommands';

export type ToolboxViewDeps = ConstructorParameters<typeof ToolboxProvider>[0];

export interface ToolboxView extends vscode.Disposable {
  say: ToolboxProvider['say'];
  /** The lines the view's message line shows, for the agent. */
  messages(): string[];
}

export function createToolboxView(deps: ToolboxViewDeps): ToolboxView {
  const provider = new ToolboxProvider(deps);
  const view = vscode.window.createTreeView(TOOLBOX_VIEW, { treeDataProvider: provider });
  const showMessage = () => { view.message = provider.viewMessage(); };
  showMessage();
  const subscriptions = [provider, view, provider.onDidChangeTreeData(showMessage)];
  return {
    say: (message) => { provider.say(message); },
    messages: () => linesOf(provider.viewMessage()),
    dispose: () => { vscode.Disposable.from(...subscriptions).dispose(); },
  };
}
