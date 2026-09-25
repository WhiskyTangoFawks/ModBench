import { describe, expect, it, vi } from 'vitest';
import { resolveCompileTarget } from '../compileTarget';

describe('resolveCompileTarget', () => {
  function deps(overrides: Partial<Parameters<typeof resolveCompileTarget>[1]> = {}) {
    return {
      resolveOrigin: vi.fn().mockResolvedValue('SomeMod'),
      pickPlugin: vi.fn().mockResolvedValue({ name: 'Picked.esp', origin: 'PickedMod' }),
      onError: vi.fn(),
      ...overrides,
    };
  }

  it('a tree row wins over the QuickPick', async () => {
    const d = deps();
    const target = await resolveCompileTarget('Row.esp', d);

    expect(target).toEqual({ name: 'Row.esp', origin: 'SomeMod' });
    expect(d.resolveOrigin).toHaveBeenCalledWith('Row.esp');
    expect(d.pickPlugin).not.toHaveBeenCalled();
  });

  it('falls back to the QuickPick when there is no tree row', async () => {
    const d = deps();
    const target = await resolveCompileTarget(undefined, d);

    expect(target).toEqual({ name: 'Picked.esp', origin: 'PickedMod' });
    expect(d.pickPlugin).toHaveBeenCalledOnce();
  });

  it('a tree row whose origin cannot be resolved reports the error and never falls through', async () => {
    const d = deps({ resolveOrigin: vi.fn().mockResolvedValue(undefined) });
    const target = await resolveCompileTarget('Row.esp', d);

    expect(target).toBeUndefined();
    expect(d.onError).toHaveBeenCalledWith('Could not resolve which mod "Row.esp" belongs to.');
    expect(d.pickPlugin).not.toHaveBeenCalled();
  });

  // The QuickPick is the last tier, so a rejecting pickPlugin has nowhere to fall through to: it must
  // report through onError and resolve to no target instead of propagating as a raw toast.
  it('reports through onError and resolves to no target when pickPlugin itself is unreachable', async () => {
    const d = deps({ pickPlugin: vi.fn().mockRejectedValue(new Error('fetch failed')) });
    const target = await resolveCompileTarget(undefined, d);

    expect(target).toBeUndefined();
    expect(d.onError).toHaveBeenCalledOnce();
  });
});
