import { describe, it, expect, vi, beforeEach } from 'vitest';

// #255. The name filter is one behavior shared by every Modbench list view, so it is tested
// once, here, in neither bounded context's vocabulary: a "row" is whatever the wired provider
// hands out. The fakes below stand in for the two things the widget talks to — VS Code's
// InputBox (the entry mechanism) and a TreeView (the readout surface) — and nothing else.

const h = vi.hoisted(() => {
  class FakeInputBox {
    value = '';
    placeholder = '';
    buttons: { iconPath: unknown; tooltip: string }[] = [];
    shown = false;
    disposed = false;
    private changeHandlers: ((v: string) => void)[] = [];
    private hideHandlers: (() => void)[] = [];
    private buttonHandlers: ((b: unknown) => void)[] = [];
    onDidChangeValue(cb: (v: string) => void) { this.changeHandlers.push(cb); return { dispose() { /* no-op */ } }; }
    onDidHide(cb: () => void) { this.hideHandlers.push(cb); return { dispose() { /* no-op */ } }; }
    onDidTriggerButton(cb: (b: unknown) => void) { this.buttonHandlers.push(cb); return { dispose() { /* no-op */ } }; }
    show() { this.shown = true; }
    dispose() { this.disposed = true; }
    /** The user typing. */
    type(text: string) { this.value = text; this.changeHandlers.forEach((cb) => cb(text)); }
    /** Enter, Escape, or clicking away — indistinguishable at this API. */
    hide() { this.hideHandlers.forEach((cb) => cb()); }
    pressButton() { this.buttonHandlers.forEach((cb) => cb(this.buttons[0])); }
  }
  const state = {
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    contextKeys: new Map<string, unknown>(),
    boxes: [] as FakeInputBox[],
  };
  return { FakeInputBox, state };
});

vi.mock('vscode', () => ({
  window: {
    createInputBox: () => {
      const box = new h.FakeInputBox();
      h.state.boxes.push(box);
      return box;
    },
  },
  commands: {
    registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
      h.state.commands.set(id, cb);
      return { dispose: () => h.state.commands.delete(id) };
    },
    executeCommand: (command: string, ...args: unknown[]) => {
      if (command === 'setContext') h.state.contextKeys.set(args[0] as string, args[1]);
      return Promise.resolve();
    },
  },
  ThemeIcon: class { constructor(public id: string) {} },
}));

import { registerNameFilter, type NameFilterDeps } from '../nameFilter';

const VIEW_ID = 'test.view';
const OPEN = `${VIEW_ID}.filter`;
const CLEAR = `${VIEW_ID}.clearFilter`;
const KEY = `${VIEW_ID}.filterActive`;

interface Harness {
  view: { description?: string; message?: string };
  applied: { text: string; toggleOn: boolean }[];
  filter: ReturnType<typeof registerNameFilter>;
}

function setup(overrides: Partial<NameFilterDeps> = {}): Harness {
  const view: { description?: string; message?: string } = {};
  const applied: { text: string; toggleOn: boolean }[] = [];
  const filter = registerNameFilter({
    view,
    viewId: VIEW_ID,
    placeholder: 'Filter things…',
    setFilter: (text, toggleOn) => applied.push({ text, toggleOn }),
    ...overrides,
  });
  return { view, applied, filter };
}

const open = async () => { await h.state.commands.get(OPEN)!(); };
const clear = async () => { await h.state.commands.get(CLEAR)!(); };
const currentBox = () => h.state.boxes.at(-1)!;

beforeEach(() => {
  h.state.commands.clear();
  h.state.contextKeys.clear();
  h.state.boxes.length = 0;
});

describe('the name filter is durable (#255)', () => {
  it('keeps the filter applied when the box hides — Enter, Escape and clicking a row are one API event, and none of them is an intent to discard', async () => {
    const { applied } = setup();
    await open();
    currentBox().type('arm');
    currentBox().hide();
    expect(applied.map((a) => a.text)).toEqual(['arm']);
  });

  it('disposes the hidden box — the widget is an entry mechanism, not where the filter lives', async () => {
    setup();
    await open();
    currentBox().hide();
    expect(currentBox().disposed).toBe(true);
  });

  it('reopens prefilled with the active term, so the box edits the filter rather than starting over', async () => {
    setup();
    await open();
    currentBox().type('arm');
    currentBox().hide();
    await open();
    expect(currentBox().value).toBe('arm');
  });

  it('clears only on the explicit clear command', async () => {
    const { applied } = setup();
    await open();
    currentBox().type('arm');
    currentBox().hide();
    await clear();
    expect(applied.map((a) => a.text)).toEqual(['arm', '']);
  });

  it('raises the filter-active context key while filtered and drops it on clear, driving the slot-1 icon swap', async () => {
    setup();
    await open();
    currentBox().type('arm');
    currentBox().hide();
    expect(h.state.contextKeys.get(KEY)).toBe(true);
    await clear();
    expect(h.state.contextKeys.get(KEY)).toBe(false);
  });

  it('names its commands and context key off the view id, so no two views can drift into different conventions', () => {
    setup();
    expect([...h.state.commands.keys()]).toEqual(['test.view.filter', 'test.view.clearFilter']);
  });

  it('treats a term typed back to empty as no filter, without needing the clear command', async () => {
    setup();
    await open();
    currentBox().type('arm');
    currentBox().type('');
    expect(h.state.contextKeys.get(KEY)).toBe(false);
  });
});

describe('the active term reads out in the view description (#255)', () => {
  it('names the active term, so the user can see what they are filtered by without opening anything', async () => {
    const { view } = setup();
    await open();
    currentBox().type('arm');
    expect(view.description).toBe('"arm"');
  });

  it('says nothing when no filter is active', async () => {
    const { view } = setup();
    await open();
    currentBox().type('arm');
    await clear();
    expect(view.description).toBeUndefined();
  });

  it('composes with whatever else the view says about itself — the term first, then the base', async () => {
    const { view, filter } = setup();
    filter.setBaseDescription('Default');
    await open();
    currentBox().type('arm');
    expect(view.description).toBe('"arm" · Default');
  });

  it('leaves the base description alone while no filter is active — the Mods profile name predates this and survives it', () => {
    const { view, filter } = setup();
    filter.setBaseDescription('Default');
    expect(view.description).toBe('Default');
  });

  // The merged Plugins tree carries two independent narrowing axes (plugins.md, Toolbar):
  // this name filter and the SQL record filter. Both show, and clearing either leaves the
  // other's half of the readout standing.
  it('recomposes when the other axis changes under a live filter', async () => {
    const { view, filter } = setup();
    await open();
    currentBox().type('arm');
    filter.setBaseDescription('records: cells.sql');
    expect(view.description).toBe('"arm" · records: cells.sql');
    filter.setBaseDescription(undefined);
    expect(view.description).toBe('"arm"');
  });
});

describe('the Mods separator toggle rides on the box (#247, unchanged by #255)', () => {
  const toggle = { icon: 'list-tree', label: 'Group by separator' };

  it('reapplies the current term when the toggle is pressed, so the option takes effect without retyping', async () => {
    const { applied } = setup({ toggle });
    await open();
    currentBox().type('arm');
    currentBox().pressButton();
    expect(applied).toEqual([{ text: 'arm', toggleOn: true }, { text: 'arm', toggleOn: false }]);
  });

  it('keeps the toggle state across a reopen, since the filter it belongs to survived the hide', async () => {
    const { applied } = setup({ toggle });
    await open();
    currentBox().type('arm');
    currentBox().pressButton();
    currentBox().hide();
    await open();
    currentBox().type('armor');
    expect(applied.at(-1)).toEqual({ text: 'armor', toggleOn: false });
  });

  it('resets the toggle to on when the filter is cleared', async () => {
    const { applied } = setup({ toggle });
    await open();
    currentBox().type('arm');
    currentBox().pressButton();
    await clear();
    expect(applied.at(-1)).toEqual({ text: '', toggleOn: true });
  });
});
