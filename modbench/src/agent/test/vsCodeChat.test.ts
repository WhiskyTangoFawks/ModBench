import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { MANIFEST } from '../../test/scanSource';

const h = vi.hoisted(() => ({
  providerId: undefined as string | undefined,
  provider: undefined as { provideMcpServerDefinitions(): Promise<{ label: string; uri: { text: string } }[]> } | undefined,
}));

vi.mock('vscode', () => ({
  lm: {
    registerMcpServerDefinitionProvider: (id: string, provider: typeof h.provider) => {
      h.providerId = id;
      h.provider = provider;
      return { dispose: () => undefined };
    },
  },
  Uri: { parse: (text: string) => ({ text }) },
  McpHttpServerDefinition: class {
    constructor(readonly label: string, readonly uri: { text: string }) {}
  },
}));

import { offerToVsCodeChat } from '../vsCodeChat';

const offered = async (listening: AddressInfo | undefined) => {
  offerToVsCodeChat({ listening: Promise.resolve(listening) });
  return h.provider?.provideMcpServerDefinitions();
};

describe('Modbench in VS Code Chat', () => {
  it.each([
    ['its agent server at the address it listens on', { address: '127.0.0.1', family: 'IPv4', port: 47321 }, [{ label: 'Modbench', uri: { text: 'http://127.0.0.1:47321/mcp' } }]],
    ['nothing while its agent server is not serving', undefined, []],
  ])('offers %s', async (_name, listening, servers) => {
    expect(await offered(listening)).toEqual(servers);
  });

  it('registers under the provider package.json declares, which VS Code requires', async () => {
    await offered(undefined);
    const manifest: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    expect(manifest).toMatchObject({ contributes: { mcpServerDefinitionProviders: [{ id: h.providerId, label: 'Modbench' }] } });
  });
});
