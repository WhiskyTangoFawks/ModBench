import { describe, it, expect, vi } from 'vitest';
import { rereadDriftedPlugin } from '../rereadPlugin';

const DRIFTED = { plugin: 'A.esp', loadedOrigin: 'ModA', currentOrigin: 'ModB', currentPath: '/mods/B/A.esp' };
const GONE = { plugin: 'A.esp', loadedOrigin: 'ModA', currentOrigin: null, currentPath: null };

function makeDeps(overrides: { stagedCount?: number | Error; confirmed?: boolean } = {}) {
  const staged = overrides.stagedCount ?? 0;
  return {
    stagedChangeCount: staged instanceof Error
      ? vi.fn().mockRejectedValue(staged)
      : vi.fn().mockResolvedValue(staged),
    confirm: vi.fn().mockResolvedValue(overrides.confirmed ?? true),
    reread: vi.fn().mockResolvedValue(true),
    report: vi.fn(),
  };
}

describe('rereadDriftedPlugin', () => {
  it('re-reads from the copy the name resolves to now', async () => {
    const deps = makeDeps();

    await rereadDriftedPlugin(DRIFTED, deps);

    expect(deps.reread).toHaveBeenCalledWith('A.esp', '/mods/B/A.esp', 'ModB');
  });

  // Nothing to read. The row still flags and its tooltip still explains why; this path exists
  // because a command can also be reached from the palette or a stale menu.
  it('refuses a plugin whose name resolves to nothing, and says so', async () => {
    const deps = makeDeps();

    await rereadDriftedPlugin(GONE, deps);

    expect(deps.reread).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledWith(expect.stringContaining('A.esp'));
  });

  it('re-reads without prompting when there is no staged work to lose', async () => {
    const deps = makeDeps({ stagedCount: 0 });

    await rereadDriftedPlugin(DRIFTED, deps);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.reread).toHaveBeenCalledOnce();
  });

  // AC6: the consequence is stated before it happens — in plain words, naming the plugin and how
  // much is at stake, not a generic "changes will be lost".
  it('states how many staged edits will be discarded, and for which plugin', async () => {
    const deps = makeDeps({ stagedCount: 3 });

    await rereadDriftedPlugin(DRIFTED, deps);

    const [message, detail] = deps.confirm.mock.calls[0];
    expect(`${message} ${detail}`).toContain('A.esp');
    expect(`${message} ${detail}`).toContain('3');
    expect(`${message} ${detail}`).toContain('discard');
  });

  it('counts only the staged edits belonging to the copy that is being replaced', async () => {
    const deps = makeDeps({ stagedCount: 2 });

    await rereadDriftedPlugin(DRIFTED, deps);

    // The loaded origin, not the incoming one: those are the edits the backend will discard.
    expect(deps.stagedChangeCount).toHaveBeenCalledWith('A.esp', 'ModA');
  });

  it('says one edit, not 1 edits', async () => {
    const deps = makeDeps({ stagedCount: 1 });

    await rereadDriftedPlugin(DRIFTED, deps);

    const [message, detail] = deps.confirm.mock.calls[0];
    expect(`${message} ${detail}`).not.toMatch(/1 (staged )?edits/);
  });

  it('touches nothing when the user declines', async () => {
    const deps = makeDeps({ stagedCount: 3, confirmed: false });

    await rereadDriftedPlugin(DRIFTED, deps);

    expect(deps.reread).not.toHaveBeenCalled();
  });

  // Same rule as SessionController.hasPendingChanges, and for the same reason: a spurious confirm
  // costs one click, a silently-skipped one risks an unrecoverable discard.
  it('confirms anyway when it cannot find out how much is staged', async () => {
    const deps = makeDeps({ stagedCount: new Error('no session'), confirmed: false });

    await rereadDriftedPlugin(DRIFTED, deps);

    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.reread).not.toHaveBeenCalled();
  });

  // And it does not invent one. A modal claiming "1 staged edit" over five of them would have the
  // user make an irreversible decision on a number we made up.
  it('does not name a count it could not read', async () => {
    const deps = makeDeps({ stagedCount: new Error('no session') });

    await rereadDriftedPlugin(DRIFTED, deps);

    const [message, detail] = deps.confirm.mock.calls[0];
    expect(`${message} ${detail}`).not.toMatch(/\d+ staged edit/);
    expect(`${message} ${detail}`).toContain('discard');
  });

  it('reports whether the re-read happened', async () => {
    const deps = makeDeps({ stagedCount: 0 });

    await expect(rereadDriftedPlugin(DRIFTED, deps)).resolves.toBe(true);

    const declined = makeDeps({ stagedCount: 1, confirmed: false });
    await expect(rereadDriftedPlugin(DRIFTED, declined)).resolves.toBe(false);
  });
});
