import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
  },
}));

import { ActiveRecordTracker } from '../ActiveRecordTracker';

// #282: panel identity is an opaque token here — the tracker never touches WebviewPanel-specific
// members (`.active`, `.onDidChangeViewState`), so tests use plain objects, no VS Code harness.
function panel(): object {
  return {};
}

describe('ActiveRecordTracker — Referenced By\'s "active record" input (#282)', () => {
  it('setActivePanel with the panel that is already active does not refire — avoids a redundant retarget/refetch when VS Code reports the same panel active twice', () => {
    const tracker = new ActiveRecordTracker();
    const a = panel();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setActivePanel(a);
    expect(handler).not.toHaveBeenCalled();
  });

  it('setFormKey on the active panel fires the new formKey', () => {
    const tracker = new ActiveRecordTracker();
    const a = panel();
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setFormKey(a, '000001:Fallout4.esm');
    expect(handler).toHaveBeenCalledWith('000001:Fallout4.esm');
  });

  it('setFormKey on a panel that is not active does not fire', () => {
    const tracker = new ActiveRecordTracker();
    const a = panel();
    const b = panel();
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setFormKey(b, '000002:Fallout4.esm');
    expect(handler).not.toHaveBeenCalled();
  });

  it('switching the active panel fires with that panel\'s own tracked formKey', () => {
    const tracker = new ActiveRecordTracker();
    const a = panel();
    const b = panel();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setFormKey(b, '000002:Fallout4.esm');
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setActivePanel(b);
    expect(handler).toHaveBeenCalledWith('000002:Fallout4.esm');
  });

  it('switching to a panel with no tracked formKey yet fires undefined', () => {
    const tracker = new ActiveRecordTracker();
    const a = panel();
    const b = panel();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setActivePanel(b);
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it('removePanel on the active panel fires undefined — nothing else is active', () => {
    const tracker = new ActiveRecordTracker();
    const a = panel();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.removePanel(a);
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it('removePanel on an inactive panel does not fire', () => {
    const tracker = new ActiveRecordTracker();
    const a = panel();
    const b = panel();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setFormKey(b, '000002:Fallout4.esm');
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.removePanel(b);
    expect(handler).not.toHaveBeenCalled();
  });

  it('current() reflects the latest state without needing a subscriber', () => {
    const tracker = new ActiveRecordTracker();
    const a = panel();
    expect(tracker.current()).toBeUndefined();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setActivePanel(a);
    expect(tracker.current()).toBe('000001:Fallout4.esm');
  });
});
