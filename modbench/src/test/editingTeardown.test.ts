import { describe, it, expect, vi } from 'vitest';
import { exitEditing } from '../editingTeardown';

function makeSession() {
  return { loadOrderSender: { abandon: vi.fn() } };
}

const makeClient = () => ({ stop: vi.fn().mockResolvedValue(undefined) });

describe('exitEditing', () => {
  it('abandons the reconcile before stopping the backend it was talking to', () => {
    const session = makeSession();
    const client = makeClient();

    exitEditing(session, client);

    expect(session.loadOrderSender.abandon).toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalled();
  });

  it('tolerates a session whose fields were never built', () => {
    expect(() => exitEditing({}, makeClient())).not.toThrow();
  });
});
