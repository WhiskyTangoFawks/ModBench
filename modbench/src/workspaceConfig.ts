import * as vscode from 'vscode';

export const attachPort = (): number | null | undefined => vscode.workspace.getConfiguration('modbench').get<number | null>('attachToBackendPort');
