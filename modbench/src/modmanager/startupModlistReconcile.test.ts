import { describe, it, expect, vi } from 'vitest';
import { reconcileModlistWithModsDir } from './startupModlistReconcile';

function makeDeps({
  added = [] as string[],
  pruned = [] as string[],
}: { added?: string[]; pruned?: string[] } = {}) {
  return {
    source: {
      registerUnlistedMods: vi.fn().mockResolvedValue(added),
      pruneDeadEntries: vi.fn().mockResolvedValue(pruned),
    },
    invalidate: vi.fn(),
    channel: { info: vi.fn(), error: vi.fn() },
  };
}

describe('reconcileModlistWithModsDir — one-time startup pass (#93)', () => {
  it('registers and prunes, then invalidates the tree once when anything changed', async () => {
    const deps = makeDeps({ added: ['New Mod'], pruned: ['Gone Mod'] });

    await reconcileModlistWithModsDir(deps.source, deps.invalidate, deps.channel);

    expect(deps.source.registerUnlistedMods).toHaveBeenCalled();
    expect(deps.source.pruneDeadEntries).toHaveBeenCalled();
    expect(deps.invalidate).toHaveBeenCalledTimes(1);
    // Silent by ruling: disk is the source of truth and the user made the change —
    // the log line is the only record, never a toast.
    expect(deps.channel.info).toHaveBeenCalledWith(expect.stringContaining('New Mod'));
    expect(deps.channel.info).toHaveBeenCalledWith(expect.stringContaining('Gone Mod'));
  });

  it('does not invalidate the tree when nothing changed', async () => {
    const deps = makeDeps();

    await reconcileModlistWithModsDir(deps.source, deps.invalidate, deps.channel);

    expect(deps.invalidate).not.toHaveBeenCalled();
    expect(deps.channel.info).not.toHaveBeenCalled();
  });

  it('a failure is logged, never thrown — startup must not die on a reconcile blip', async () => {
    const deps = makeDeps();
    deps.source.pruneDeadEntries.mockRejectedValue(new Error('EACCES'));

    await expect(
      reconcileModlistWithModsDir(deps.source, deps.invalidate, deps.channel),
    ).resolves.toBeUndefined();

    expect(deps.channel.error).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });

  it('still prunes when registration alone changed nothing', async () => {
    const deps = makeDeps({ pruned: ['Gone Mod'] });

    await reconcileModlistWithModsDir(deps.source, deps.invalidate, deps.channel);

    expect(deps.invalidate).toHaveBeenCalledTimes(1);
  });
});
