import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
  },
}));

import { ActiveRecordTracker } from '../ActiveRecordTracker';

function opaquePanelToken(): object {
  return {};
}

describe('ActiveRecordTracker — Referenced By\'s "active record" input', () => {
  it('setActivePanel with the panel that is already active does not refire — avoids a redundant retarget/refetch when VS Code reports the same panel active twice', () => {
    const tracker = new ActiveRecordTracker();
    const a = opaquePanelToken();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setActivePanel(a);
    expect(handler).not.toHaveBeenCalled();
  });

  it('setFormKey on the active panel fires the new formKey', () => {
    const tracker = new ActiveRecordTracker();
    const a = opaquePanelToken();
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setFormKey(a, '000001:Fallout4.esm');
    expect(handler).toHaveBeenCalledWith('000001:Fallout4.esm');
  });

  it('setFormKey on a panel that is not active does not fire', () => {
    const tracker = new ActiveRecordTracker();
    const a = opaquePanelToken();
    const b = opaquePanelToken();
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setFormKey(b, '000002:Fallout4.esm');
    expect(handler).not.toHaveBeenCalled();
  });

  it('switching the active panel fires with that panel\'s own tracked formKey', () => {
    const tracker = new ActiveRecordTracker();
    const a = opaquePanelToken();
    const b = opaquePanelToken();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setFormKey(b, '000002:Fallout4.esm');
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setActivePanel(b);
    expect(handler).toHaveBeenCalledWith('000002:Fallout4.esm');
  });

  it('switching to a panel with no tracked formKey yet fires undefined', () => {
    const tracker = new ActiveRecordTracker();
    const a = opaquePanelToken();
    const b = opaquePanelToken();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.setActivePanel(b);
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it('removePanel on the last panel fires undefined — no record tab is left', () => {
    const tracker = new ActiveRecordTracker();
    const a = opaquePanelToken();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.removePanel(a);
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it('removePanel on the active panel while another stays open keeps the record until another tab is focused', () => {
    const tracker = new ActiveRecordTracker();
    const a = opaquePanelToken();
    const b = opaquePanelToken();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setFormKey(b, '000002:Fallout4.esm');
    tracker.setActivePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.removePanel(a);
    expect(handler).not.toHaveBeenCalled();
    expect(tracker.current()).toBe('000001:Fallout4.esm');
    tracker.setActivePanel(b);
    expect(handler).toHaveBeenCalledWith('000002:Fallout4.esm');
  });

  it('removePanel on the last panel left fires undefined even when it was never the active one', () => {
    const tracker = new ActiveRecordTracker();
    const a = opaquePanelToken();
    const b = opaquePanelToken();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setFormKey(b, '000002:Fallout4.esm');
    tracker.setActivePanel(a);
    tracker.removePanel(a);
    const handler = vi.fn();
    tracker.onDidChangeActiveRecord(handler);
    tracker.removePanel(b);
    expect(handler).toHaveBeenCalledWith(undefined);
    expect(tracker.current()).toBeUndefined();
  });

  it('removePanel on an inactive panel does not fire', () => {
    const tracker = new ActiveRecordTracker();
    const a = opaquePanelToken();
    const b = opaquePanelToken();
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
    const a = opaquePanelToken();
    expect(tracker.current()).toBeUndefined();
    tracker.setFormKey(a, '000001:Fallout4.esm');
    tracker.setActivePanel(a);
    expect(tracker.current()).toBe('000001:Fallout4.esm');
  });
});
