import * as vscode from 'vscode';
import type { AgentServer } from './agentServer';

const MCP_SERVER_PROVIDER_ID = 'modbench';

export function offerToVsCodeChat(server: Pick<AgentServer, 'listening'>): vscode.Disposable {
  return vscode.lm.registerMcpServerDefinitionProvider(MCP_SERVER_PROVIDER_ID, {
    provideMcpServerDefinitions: async () => {
      const address = await server.listening;
      if (address === undefined) return [];
      return [new vscode.McpHttpServerDefinition('Modbench', vscode.Uri.parse(`http://${address.address}:${String(address.port)}/mcp`))];
    },
  });
}
