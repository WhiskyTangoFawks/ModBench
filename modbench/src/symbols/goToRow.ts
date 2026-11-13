import * as vscode from 'vscode';
import type { Reveal } from '../drivingLib/symbolRows';
import type { Reporter } from '../ports/reporter';

interface GoTo {
  name: string;
  show: Reveal | undefined;
  file: string | undefined;
  reporter: Pick<Reporter, 'report'>;
  nowhere: string;
}

/** `go to` on an object a view lists: select its row, else show its file in the Explorer, else say `nowhere` of `name`. */
export async function goToRowOrFile({ name, show, file, reporter, nowhere }: GoTo): Promise<void> {
  if (show !== undefined) {
    await show();
    return;
  }
  if (file === undefined) {
    reporter.report('error', `Could not go to ${name}: ${nowhere}`);
    return;
  }
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
}
