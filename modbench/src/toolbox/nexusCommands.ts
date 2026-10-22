import * as vscode from 'vscode';
import type { Nexus } from '../nexus/nexus';

const LOGGED_IN_KEY = 'modbench.nexus.loggedIn';

interface NexusCommandDeps {
  nexus: Pick<Nexus, 'check' | 'keep' | 'forget' | 'loggedIn'>;
}

// The log in / log out gestures (toolbox.md, Log in), and the context key the title bar's menu reads.
export function registerNexusCommands({ nexus }: NexusCommandDeps): vscode.Disposable[] {
  const markLoggedIn = (loggedIn: boolean) => vscode.commands.executeCommand('setContext', LOGGED_IN_KEY, loggedIn);
  void nexus.loggedIn().then(markLoggedIn);
  return [
    vscode.commands.registerCommand('modbench.instance.logIn', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Nexus API key',
        password: true,
        ignoreFocusOut: true,
        validateInput: async (value) => {
          const checked = await nexus.check(value);
          return checked.valid ? undefined : checked.reason;
        },
      });
      if (key === undefined) return;
      await nexus.keep(key);
      await markLoggedIn(true);
    }),
    vscode.commands.registerCommand('modbench.instance.logOut', async () => {
      await nexus.forget();
      await markLoggedIn(false);
    }),
  ];
}
