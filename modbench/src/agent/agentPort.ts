import * as vscode from 'vscode';

export const AGENT_PORT_SETTING = 'modbench.agent.port';

export function agentPort(): number {
  const port = vscode.workspace.getConfiguration('modbench').get<number>('agent.port');
  if (port === undefined) throw new Error(`${AGENT_PORT_SETTING} has no value: package.json declares its default.`);
  return port;
}
