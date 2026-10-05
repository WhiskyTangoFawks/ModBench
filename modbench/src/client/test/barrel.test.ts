import { describe, expect, it } from 'vitest';
import { createMEditClient } from '..';

describe('createMEditClient', () => {
  it('answers the port, whose stop shuts the backend it attached to', async () => {
    const client = createMEditClient({ backend: { attachPort: 5172 }, backendLog: { appendLine: () => undefined } as never });

    await expect(client.stop()).resolves.toBeUndefined();
  });
});
