import { describe, expect, it, vi } from 'vitest';
import { createMEditClient } from '..';

describe('createMEditClient', () => {
  it('answers the port, whose stop shuts the backend it attached to', async () => {
    const client = createMEditClient({ backend: { attachPort: 5172 }, backendLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logLevel: 3 } });

    await expect(client.stop()).resolves.toBeUndefined();
  });
});
