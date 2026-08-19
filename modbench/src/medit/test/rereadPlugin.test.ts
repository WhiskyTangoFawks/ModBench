import { describe, it, expect, vi } from 'vitest';
import { rereadDriftedPlugin } from '../rereadPlugin';

const DRIFTED = { plugin: 'A.esp', loadedOrigin: 'ModA', currentOrigin: 'ModB', currentPath: '/mods/B/A.esp' };
const GONE = { plugin: 'A.esp', loadedOrigin: 'ModA', currentOrigin: null, currentPath: null };

function makeDeps() {
  return {
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

  // #410/ADR-0041: no confirm. It existed to warn that the re-read would discard staged edits
  // against the copy being replaced; with the pending model gone a re-read destroys nothing.
  it('re-reads without prompting', async () => {
    const deps = makeDeps();

    await rereadDriftedPlugin(DRIFTED, deps);

    expect(deps.reread).toHaveBeenCalledOnce();
  });

  // Nothing to read. The row still flags and its tooltip still explains why; this path exists
  // because a command can also be reached from the palette or a stale menu.
  it('refuses a plugin whose name resolves to nothing, and says so', async () => {
    const deps = makeDeps();

    await rereadDriftedPlugin(GONE, deps);

    expect(deps.reread).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledWith(expect.stringContaining('A.esp'));
  });

  it('reports whether the re-read happened', async () => {
    const deps = makeDeps();
    await expect(rereadDriftedPlugin(DRIFTED, deps)).resolves.toBe(true);

    const gone = makeDeps();
    await expect(rereadDriftedPlugin(GONE, gone)).resolves.toBe(false);
  });
});
