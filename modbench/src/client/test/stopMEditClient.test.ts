import { describe, it, expect, vi, beforeEach } from 'vitest';

const backendLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logLevel: 3 };

describe('stopMEditClient', () => {
  beforeEach(() => { vi.resetModules(); });

  it('resolves when no client was created', async () => {
    const { stopMEditClient } = await import('../index');

    await expect(stopMEditClient()).resolves.toBeUndefined();
  });

  it('stops the client the last createMEditClient made', async () => {
    const { createMEditClient, stopMEditClient } = await import('../index');
    const client = createMEditClient({ backend: { attachPort: 5172 }, backendLog });
    const stop = vi.spyOn(client, 'stop').mockResolvedValue();

    await stopMEditClient();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
