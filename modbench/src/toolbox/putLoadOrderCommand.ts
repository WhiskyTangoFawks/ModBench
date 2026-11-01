import * as vscode from 'vscode';
import type { Instance, InstanceValue } from '../instanceLoader/instance';
import { onSettingChange } from '../drivingLib/setting';

interface Editing {
  onRecompute(source: InstanceValue['loadOrderSnapshot'], stringsLanguage: string | undefined): void;
}

const STRINGS_LANGUAGE_SETTING = 'stringsLanguage';

/** Hands mEdit the instance value at every recompute and at every change of the strings language,
 *  with the language the setting holds when the put is made (ADR-0013). */
export function registerPutLoadOrder(editing: Editing, instance: Pick<Instance, 'subscribe' | 'value'>): vscode.Disposable {
  const put = (value: InstanceValue): void => {
    editing.onRecompute(value.loadOrderSnapshot, vscode.workspace.getConfiguration('modbench').get<string>(STRINGS_LANGUAGE_SETTING));
  };
  return vscode.Disposable.from(
    instance.subscribe(put),
    onSettingChange(vscode.workspace.onDidChangeConfiguration, `modbench.${STRINGS_LANGUAGE_SETTING}`, () => { put(instance.value); }),
    vscode.commands.registerCommand('modbench.instance.putLoadOrder', put),
  );
}
