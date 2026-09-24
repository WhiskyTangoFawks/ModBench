import type * as vscode from 'vscode';
import type { InstanceView } from './instanceLoader/instance';

/** One Output line per failure however many views show it (common.md, States, story 2, scoped to
 *  the Downloads view alone). A folder resolved again after being unresolved, or unresolved for a
 *  different reason, is a new failure. */
export function logDownloadsFolderUnresolved(
  instance: Pick<InstanceView, 'subscribe'>, log: (line: string) => void,
): vscode.Disposable {
  let reported: string | undefined;
  return instance.subscribe(({ downloads }) => {
    const line = downloads.kind === 'unresolved' ? downloads.reason : undefined;
    if (line !== undefined && line !== reported) log(line);
    reported = line;
  });
}
