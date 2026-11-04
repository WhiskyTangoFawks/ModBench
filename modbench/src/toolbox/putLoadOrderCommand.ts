import * as vscode from 'vscode';
import type { Instance, InstanceValue } from '../instanceLoader/instance';
import { onSettingChange } from '../drivingLib/setting';

interface Editing {
  onRecompute(source: InstanceValue['loadOrderSnapshot'], stringsLanguage: string | undefined): void;
  signalChange(): void;
}

const STRINGS_LANGUAGE_SETTING = 'stringsLanguage';

/** At every recompute, puts the load order with the strings language the setting holds then (ADR-0013) and signals a
 *  change (ADR-0015); at every change of the strings language, puts the load order. */
export function registerPutLoadOrder(editing: Editing, instance: Pick<Instance, 'subscribe' | 'value'>): vscode.Disposable {
  const put = (value: InstanceValue): void => {
    editing.onRecompute(value.loadOrderSnapshot, vscode.workspace.getConfiguration('modbench').get<string>(STRINGS_LANGUAGE_SETTING));
  };
  const signalChange = (): void => { editing.signalChange(); };
  return vscode.Disposable.from(
    instance.subscribe((value) => {
      put(value);
      signalChange();
    }),
    onSettingChange(vscode.workspace.onDidChangeConfiguration, `modbench.${STRINGS_LANGUAGE_SETTING}`, () => { put(instance.value); }),
    vscode.commands.registerCommand('modbench.instance.putLoadOrder', put),
    vscode.commands.registerCommand('modbench.instance.signalChange', signalChange),
  );
}
