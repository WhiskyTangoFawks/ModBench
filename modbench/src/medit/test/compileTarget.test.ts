import { describe, expect, it, vi } from 'vitest';
import { resolveCompileTarget } from '../compileTarget';

describe('resolveCompileTarget (#416 review)', () => {
  function deps(overrides: Partial<Parameters<typeof resolveCompileTarget>[2]> = {}) {
    return {
      resolveOrigin: vi.fn().mockResolvedValue('SomeMod'),
      getRecordOwner: vi.fn().mockResolvedValue({ plugin: 'Active.esp', origin: 'ActiveMod' }),
      pickPlugin: vi.fn().mockResolvedValue({ name: 'Picked.esp', origin: 'PickedMod' }),
      onError: vi.fn(),
      ...overrides,
    };
  }

  it('a tree row wins over an active record and the palette fallback alike', async () => {
    const d = deps();
    const target = await resolveCompileTarget('Row.esp', 'AABBCC:Whatever.esp', d);

    expect(target).toEqual({ name: 'Row.esp', origin: 'SomeMod' });
    expect(d.resolveOrigin).toHaveBeenCalledWith('Row.esp');
    expect(d.getRecordOwner).not.toHaveBeenCalled();
    expect(d.pickPlugin).not.toHaveBeenCalled();
  });

  it('with no tree row, the record editor\'s active record wins over the QuickPick fallback', async () => {
    const d = deps();
    const target = await resolveCompileTarget(undefined, 'AABBCC:Active.esp', d);

    expect(target).toEqual({ name: 'Active.esp', origin: 'ActiveMod' });
    expect(d.getRecordOwner).toHaveBeenCalledWith('AABBCC:Active.esp');
    expect(d.pickPlugin).not.toHaveBeenCalled();
  });

  it('falls back to the QuickPick only when there is no tree row and no active record', async () => {
    const d = deps();
    const target = await resolveCompileTarget(undefined, undefined, d);

    expect(target).toEqual({ name: 'Picked.esp', origin: 'PickedMod' });
    expect(d.getRecordOwner).not.toHaveBeenCalled();
    expect(d.pickPlugin).toHaveBeenCalledOnce();
  });

  it('falls back to the QuickPick when the active record cannot be resolved to a plugin', async () => {
    const d = deps({ getRecordOwner: vi.fn().mockResolvedValue(undefined) });
    const target = await resolveCompileTarget(undefined, 'AABBCC:Gone.esp', d);

    expect(target).toEqual({ name: 'Picked.esp', origin: 'PickedMod' });
    expect(d.pickPlugin).toHaveBeenCalledOnce();
  });

  it('a tree row whose origin cannot be resolved reports the error and never falls through', async () => {
    const d = deps({ resolveOrigin: vi.fn().mockResolvedValue(undefined) });
    const target = await resolveCompileTarget('Row.esp', undefined, d);

    expect(target).toBeUndefined();
    expect(d.onError).toHaveBeenCalledWith('Could not resolve which mod "Row.esp" belongs to.');
    expect(d.pickPlugin).not.toHaveBeenCalled();
  });

  // Before Launch mEdit (or after Close mEdit, since exitToLoadout never resets
  // ActiveRecordTracker/closes an open record panel — the same reachable path as
  // this priority tier), getRecordOwner has no backend to ask and rejects rather than answering
  // 404. Exact parity with the already-tested "cannot be resolved to a plugin" case above: falls
  // through to the palette fallback rather than letting the rejection propagate as a raw,
  // uncaught toast.
  it('falls back to the QuickPick, not a thrown rejection, when getRecordOwner itself is unreachable', async () => {
    const d = deps({ getRecordOwner: vi.fn().mockRejectedValue(new Error('fetch failed')) });
    const target = await resolveCompileTarget(undefined, 'AABBCC:Active.esp', d);

    expect(target).toEqual({ name: 'Picked.esp', origin: 'PickedMod' });
    expect(d.pickPlugin).toHaveBeenCalledOnce();
  });

  // Unlike tier 2's getRecordOwner rejection above (which still has a fallback tier below
  // it), tier 3 is the last tier — pickPlugin rejecting (e.g. repository.getPlugins() with no
  // backend to ask, before Launch mEdit) has nowhere further to fall through to, so it must report
  // through onError and resolve to no target instead of propagating as a raw, uncaught toast.
  it('reports through onError and resolves to no target when pickPlugin itself is unreachable', async () => {
    const d = deps({ pickPlugin: vi.fn().mockRejectedValue(new Error('fetch failed')) });
    const target = await resolveCompileTarget(undefined, undefined, d);

    expect(target).toBeUndefined();
    expect(d.onError).toHaveBeenCalledOnce();
  });
});
