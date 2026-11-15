import type * as vscode from 'vscode';
import type { Concerns, InstanceValue, InstanceView } from '../instanceLoader/instance';

export function logOncePerFailure<K extends keyof InstanceValue>(
  instance: Pick<InstanceView, 'subscribe'>, concerns: Concerns<K>, lineFor: (value: Pick<InstanceValue, K>) => string | undefined, log: (line: string) => void,
): vscode.Disposable {
  let reported: string | undefined;
  return instance.subscribe((value) => {
    const line = lineFor(value);
    if (line !== undefined && line !== reported) log(line);
    reported = line;
  }, concerns);
}
