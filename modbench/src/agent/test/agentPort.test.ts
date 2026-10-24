import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ configured: undefined as number | undefined }));

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (key: string) => (key === 'agent.port' ? h.configured : undefined) }) },
}));

import { agentPort } from '../agentPort';

describe('the port the agent server takes', () => {
  it('is the configured port', () => {
    h.configured = 47300;

    expect(agentPort()).toBe(47300);
  });

  it('fails loudly when the setting has no value, rather than inventing a default the manifest owns', () => {
    h.configured = undefined;

    expect(() => agentPort()).toThrow('modbench.agent.port has no value');
  });
});
