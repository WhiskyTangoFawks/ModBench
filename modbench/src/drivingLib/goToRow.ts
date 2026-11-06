import * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';

interface GoTo<Row> {
  name: string;
  row: Row | undefined;
  file: string | undefined;
  reveal: (row: Row) => PromiseLike<void>;
  reporter: Pick<Reporter, 'report'>;
  nowhere: string;
}

/** `go to` on an object a view lists: select its row, else show its file in the Explorer, else say `nowhere` of `name`. */
export async function goToRowOrFile<Row>({ name, row, file, reveal, reporter, nowhere }: GoTo<Row>): Promise<void> {
  if (row !== undefined) {
    await reveal(row);
    return;
  }
  if (file === undefined) {
    reporter.report('error', `Could not go to ${name}: ${nowhere}`);
    return;
  }
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
}
