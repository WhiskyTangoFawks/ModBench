import { describe, it, expect, vi } from 'vitest';
import { reportReconciled } from '../loadOrderOutcome';

function makeDeps() {
  return { log: vi.fn(), warn: vi.fn(), setStatusText: vi.fn(), notifyConflictsComputed: vi.fn() };
}

function plugin(over: Partial<{ enabled: boolean; winning: boolean; slot: number | null }> = {}) {
  return { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true, ...over };
}

describe('reportReconciled', () => {
  it('writes the ready status text with the sent plugin count', () => {
    const deps = makeDeps();

    reportReconciled([plugin(), plugin()], [], deps);

    expect(deps.setStatusText).toHaveBeenCalledWith('$(check) mEdit: Ready (2 plugin copies)');
  });

  it('announces that conflicts are computed', () => {
    const deps = makeDeps();

    reportReconciled([plugin()], [], deps);

    expect(deps.notifyConflictsComputed).toHaveBeenCalledOnce();
  });

  it('warns and logs a skipped plugin, never silently (ADR-0026)', () => {
    const deps = makeDeps();

    reportReconciled([plugin()], [{ name: 'Bad.esp', reason: 'RACE parse' }], deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Bad.esp'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Bad.esp'));
  });

  it('does not warn about skipped plugins when there are none', () => {
    const deps = makeDeps();

    reportReconciled([plugin()], [], deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('warns when the active profile has zero enabled plugins', () => {
    const deps = makeDeps();

    reportReconciled([], [], deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  // ADR-0044: every copy is sent, so a non-empty snapshot does not mean the profile has anything
  // enabled — participation is enabled AND winning AND listed, derived.
  it('warns when plugins were sent but none of them participate', () => {
    const deps = makeDeps();

    reportReconciled([plugin({ enabled: false })], [], deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  it('does not warn about participation when at least one plugin participates', () => {
    const deps = makeDeps();

    reportReconciled([plugin({ enabled: false }), plugin()], [], deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });

  // The rival: statusText/notifyConflictsComputed firing even when nothing was actually sent
  // would announce a reconcile that never happened.
  it('still writes the ready text and announces conflicts even when nothing participates', () => {
    const deps = makeDeps();

    reportReconciled([], [], deps);

    expect(deps.setStatusText).toHaveBeenCalledWith('$(check) mEdit: Ready (0 plugin copies)');
    expect(deps.notifyConflictsComputed).toHaveBeenCalledOnce();
  });
});
