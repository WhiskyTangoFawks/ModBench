import * as vscode from 'vscode';
import type { Nexus } from '../nexus/nexus';
import type { NexusLogin } from '../instanceCommands/nexusLogin';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';

const LOGGED_IN_KEY = 'modbench.nexus.loggedIn';

interface NexusCommandDeps {
  commands: NexusLogin;
  nexus: Nexus;
  reporter: Reporter;
}

function askForKey(commands: NexusLogin, reporter: Reporter): Promise<void> {
  const box = vscode.window.createInputBox();
  box.title = 'Nexus API key';
  box.password = true;
  box.ignoreFocusOut = true;
  const closed = new AbortController();
  box.onDidAccept(async () => {
    if (box.busy) return;
    box.busy = true;
    const outcome = await commands.logIn(box.value, closed.signal);
    box.busy = false;
    if (closed.signal.aborted) return;
    if (outcome.applied) {
      box.hide();
      return;
    }
    box.validationMessage = outcome.refusal;
    reporter.shownOnSurface('error', 'Nexus did not take the key.', outcome.refusal);
  });
  return new Promise((resolve) => {
    box.onDidHide(() => { closed.abort(); box.dispose(); resolve(); });
    box.show();
  });
}

export function registerNexusCommands({ commands, nexus, reporter }: NexusCommandDeps): vscode.Disposable[] {
  const markLoggedIn = async (): Promise<void> => {
    try {
      await vscode.commands.executeCommand('setContext', LOGGED_IN_KEY, await nexus.loggedIn());
    } catch (err) {
      reporter.report('error', 'Could not read whether you are logged in to Nexus.', errorMessage(err));
    }
  };
  void markLoggedIn();
  return [
    nexus.onDidChangeLogin(() => { void markLoggedIn(); }),
    vscode.commands.registerCommand('modbench.instance.logIn', () => askForKey(commands, reporter)),
    vscode.commands.registerCommand('modbench.instance.logOut', async () => {
      const outcome = await commands.logOut();
      if (!outcome.applied) reporter.report('error', 'Failed to log out of Nexus.', outcome.refusal);
    }),
  ];
}
