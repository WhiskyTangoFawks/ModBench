import { describe, it, expect, vi } from 'vitest';
import { makeReloadSession } from '../reloadSession';

function makeDeps(overrides: { hasPendingChanges?: boolean; confirmed?: boolean } = {}) {
  return {
    hasPendingChanges: vi.fn().mockResolvedValue(overrides.hasPendingChanges ?? false),
    confirm: vi.fn().mockResolvedValue(overrides.confirmed ?? true),
    reload: vi.fn().mockResolvedValue(undefined),
  };
}

describe('makeReloadSession', () => {
  it('reloads without prompting when nothing is staged (AC3)', async () => {
    const deps = makeDeps({ hasPendingChanges: false });

    await makeReloadSession(deps)();

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it('confirms modally, then reloads, when pending changes exist and the user confirms (AC2)', async () => {
    const deps = makeDeps({ hasPendingChanges: true, confirmed: true });

    await makeReloadSession(deps)();

    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  // AC2: cancelling must leave the session untouched — not merely "the reload call was
  // skipped", but structurally never invoked, since reload is the only thing that touches
  // backend/session state. Asserting zero calls on that mock *is* the proof.
  it('leaves the session untouched when pending changes exist and the user cancels (AC2)', async () => {
    const deps = makeDeps({ hasPendingChanges: true, confirmed: false });

    await makeReloadSession(deps)();

    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('checks for pending changes before ever prompting or reloading', async () => {
    const order: string[] = [];
    const deps = {
      hasPendingChanges: vi.fn().mockImplementation(async () => { order.push('hasPendingChanges'); return true; }),
      confirm: vi.fn().mockImplementation(async () => { order.push('confirm'); return true; }),
      reload: vi.fn().mockImplementation(async () => { order.push('reload'); }),
    };

    await makeReloadSession(deps)();

    expect(order).toEqual(['hasPendingChanges', 'confirm', 'reload']);
  });
});
