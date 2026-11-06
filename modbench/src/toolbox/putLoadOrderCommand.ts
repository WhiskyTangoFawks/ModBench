import * as vscode from 'vscode';
import type { Instance, InstanceValue, Reread } from '../instanceLoader/instance';
import { onSettingChange } from '../drivingLib/setting';

interface Editing {
  onRecompute(source: InstanceValue['loadOrderSnapshot'], stringsLanguage: string | undefined): void;
  signalChange(paths: readonly string[]): void;
}

const STRINGS_LANGUAGE_SETTING = 'stringsLanguage';

/** At every recompute, puts the load order with the strings language set then (ADR-0013) and signals a change at the
 *  paths read again, or none at a check (ADR-0015); at every change of the strings language, puts it. */
export function registerPutLoadOrder(editing: Editing, instance: Pick<Instance, 'subscribe' | 'value'>): vscode.Disposable {
  const put = (value: InstanceValue): void => {
    editing.onRecompute(value.loadOrderSnapshot, vscode.workspace.getConfiguration('modbench').get<string>(STRINGS_LANGUAGE_SETTING));
  };
  const signalChange = ({ named, disk }: Reread): void => { editing.signalChange(disk ? [] : named); };
  return vscode.Disposable.from(
    instance.subscribe((value, _sequence, reread) => {
      put(value);
      signalChange(reread);
    }),
    onSettingChange(vscode.workspace.onDidChangeConfiguration, `modbench.${STRINGS_LANGUAGE_SETTING}`, () => { put(instance.value); }),
    vscode.commands.registerCommand('modbench.instance.putLoadOrder', put),
    vscode.commands.registerCommand('modbench.instance.signalChange', () => { editing.signalChange([]); }),
  );
}
