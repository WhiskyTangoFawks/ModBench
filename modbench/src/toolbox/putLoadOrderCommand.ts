import * as vscode from 'vscode';
import type { Instance, InstanceValue, Reread } from '../instanceLoader/instance';
import { onSettingChange } from '../drivingLib/setting';

interface Editing {
  onRecompute(source: InstanceValue['loadOrderSnapshot'], stringsLanguage: string | undefined): void;
  signalChange(paths: readonly string[]): Promise<void>;
}

const STRINGS_LANGUAGE_SETTING = 'stringsLanguage';

/** At every recompute, puts the load order with the strings language set then (ADR-0013) and signals a change at the
 *  paths read again, or none at a check; at every change of the strings language, puts it. */
export function registerPutLoadOrder(editing: Editing, instance: Pick<Instance, 'subscribe' | 'value'>): vscode.Disposable {
  const put = (value: Pick<InstanceValue, 'loadOrderSnapshot'>): void => {
    editing.onRecompute(value.loadOrderSnapshot, vscode.workspace.getConfiguration('modbench').get<string>(STRINGS_LANGUAGE_SETTING));
  };
  const signalChange = ({ named, disk }: Reread): Promise<void> => {
    if (disk) return editing.signalChange([]);
    return named.length > 0 ? editing.signalChange(named) : Promise.resolve();
  };
  return vscode.Disposable.from(
    instance.subscribe(put, { loadOrderSnapshot: true }),
    instance.subscribe((_value, _sequence, reread) => signalChange(reread)),
    onSettingChange(vscode.workspace.onDidChangeConfiguration, `modbench.${STRINGS_LANGUAGE_SETTING}`, () => { put(instance.value); }),
    vscode.commands.registerCommand('modbench.instance.putLoadOrder', put),
    vscode.commands.registerCommand('modbench.instance.signalChange', () => editing.signalChange([])),
  );
}
