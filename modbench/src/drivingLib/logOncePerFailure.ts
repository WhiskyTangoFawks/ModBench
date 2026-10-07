import type * as vscode from 'vscode';
import type { InstanceValue, InstanceView } from '../instanceLoader/instance';

export function logOncePerFailure(
  instance: Pick<InstanceView, 'subscribe'>, lineFor: (value: InstanceValue) => string | undefined, log: (line: string) => void,
): vscode.Disposable {
  let reported: string | undefined;
  return instance.subscribe((value) => {
    const line = lineFor(value);
    if (line !== undefined && line !== reported) log(line);
    reported = line;
  });
}
