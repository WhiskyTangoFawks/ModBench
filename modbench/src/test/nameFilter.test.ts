import { describe, it, expect, vi, beforeEach } from 'vitest';

// One behaviour shared by every Modbench list view, tested once, here, in neither bounded
// context's vocabulary: a "row" is whatever the wired provider hands out. The fakes stand in
// for an InputBox and a TreeView, nothing else.

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
    type(text: string) { this.value = text; this.changeHandlers.forEach((cb) => cb(text)); }
    // Enter, Escape, or clicking away — indistinguishable at this API.
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
      if (command === 'setContext' && typeof args[0] === 'string') h.state.contextKeys.set(args[0], args[1]);
      return Promise.resolve();
    },
  },
  ThemeIcon: class { constructor(public id: string) {} },
}));

import { registerNameFilter, type NameFilterDeps } from '../nameFilter';
import { present } from '../ports/present';

const OBJECT = 'test.thing';
const OPEN = `${OBJECT}.filter`;
const CLEAR = `${OBJECT}.clearFilter`;
const KEY = `${OBJECT}.filterActive`;

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
    object: OBJECT,
    placeholder: 'Filter things…',
    setFilter: (text, toggleOn) => applied.push({ text, toggleOn }),
    hasRows: () => Promise.resolve(true),
    ...overrides,
  });
  return { view, applied, filter };
}

const open = async () => { await present(h.state.commands.get(OPEN), "the filter's open command")(); };
const clear = async () => { await present(h.state.commands.get(CLEAR), "the filter's clear command")(); };

// A minimal `vscode.Event<unknown>` double: a view's own row-change signal, fired by the test in
// place of a real provider's `onDidChangeTreeData`.
function fakeRowsChangedEvent() {
  const handlers: ((e: unknown) => void)[] = [];
  return {
    event: (cb: (e: unknown) => void) => {
      handlers.push(cb);
      return { dispose: () => { const i = handlers.indexOf(cb); if (i >= 0) handlers.splice(i, 1); } };
    },
    fire: () => handlers.forEach((cb) => cb(undefined)),
  };
}
const currentBox = () => present(h.state.boxes.at(-1), 'the most recently created input box');
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  h.state.commands.clear();
  h.state.contextKeys.clear();
  h.state.boxes.length = 0;
});

describe('the name filter is durable', () => {
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

  it('names its commands and context key off the object, so no two views can drift into different conventions', () => {
    setup();
    expect([...h.state.commands.keys()]).toEqual(['test.thing.filter', 'test.thing.clearFilter']);
  });

  it('treats a term typed back to empty as no filter, without needing the clear command', async () => {
    setup();
    await open();
    currentBox().type('arm');
    currentBox().type('');
    expect(h.state.contextKeys.get(KEY)).toBe(false);
  });
});

describe('the active term reads out in the view description', () => {
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

describe('a term that matches nothing says so', () => {
  it('names the term rather than leaving a bare empty tree, which reads as "there is nothing here"', async () => {
    const { view } = setup({ hasRows: () => Promise.resolve(false) });
    await open();
    currentBox().type('zzz');
    await flush();
    expect(view.message).toBe('No matches for "zzz".');
  });

  it('says nothing while rows match', async () => {
    const { view } = setup({ hasRows: () => Promise.resolve(true) });
    await open();
    currentBox().type('arm');
    await flush();
    expect(view.message).toBeUndefined();
  });

  it('takes the message back down when the filter is cleared', async () => {
    const { view } = setup({ hasRows: () => Promise.resolve(false) });
    await open();
    currentBox().type('zzz');
    await flush();
    await clear();
    await flush();
    expect(view.message).toBeUndefined();
  });

  // ADR-0019: the message is decided by what survived the filter, not by whether the term matched.
  // A view whose rows are an error row still has rows; "no matches" sends that user
  // debugging the filter instead of the data.
  it('stays silent when what survived the filter is an error row', async () => {
    const { view } = setup({ hasRows: () => Promise.resolve(true) });
    await open();
    currentBox().type('zzz');
    await flush();
    expect(view.message).toBeUndefined();
  });

  // The Plugins view has one message surface and two claimants: the load's own statement and this.
  // The load wins while running; `refresh` is how the filter gets its statement back.
  it('restates its message on refresh, after something else has taken the view message surface', async () => {
    const { view, filter } = setup({ hasRows: () => Promise.resolve(false) });
    await open();
    currentBox().type('zzz');
    await flush();
    view.message = 'Loading plugins…';
    filter.refresh();
    await flush();
    expect(view.message).toBe('No matches for "zzz".');
  });

  it('leaves the message alone when no filter is active — the view has other things to say', async () => {
    const { view } = setup({ hasRows: () => Promise.resolve(false) });
    view.message = 'Loading plugins…';
    await open();
    currentBox().hide();
    await flush();
    expect(view.message).toBe('Loading plugins…');
  });
});

describe('the message follows the view\'s own row-change signal', () => {
  it('recomputes in both directions off onRowsChanged alone, with a keystroke setting the term once beforehand', async () => {
    let matches = false;
    const rows = fakeRowsChangedEvent();
    const { view } = setup({ hasRows: () => Promise.resolve(matches), onRowsChanged: rows.event });
    await open();
    currentBox().type('zzz');
    await flush();
    expect(view.message).toBe('No matches for "zzz".');

    matches = true;
    rows.fire();
    await flush();
    expect(view.message).toBeUndefined();

    matches = false;
    rows.fire();
    await flush();
    expect(view.message).toBe('No matches for "zzz".');
  });

  it('does nothing while no filter is active — a provider free to fire whenever must not conjure a message', async () => {
    const rows = fakeRowsChangedEvent();
    const { view } = setup({ hasRows: () => Promise.resolve(false), onRowsChanged: rows.event });
    rows.fire();
    await flush();
    expect(view.message).toBeUndefined();
  });

  it('stops recomputing once the filter is disposed, alongside its commands', async () => {
    let matches = false;
    const rows = fakeRowsChangedEvent();
    const { view, filter } = setup({ hasRows: () => Promise.resolve(matches), onRowsChanged: rows.event });
    await open();
    currentBox().type('zzz');
    await flush();
    expect(view.message).toBe('No matches for "zzz".');

    filter.dispose();
    matches = true;
    rows.fire();
    await flush();
    expect(view.message).toBe('No matches for "zzz".');
  });

  it('leaves another owner\'s message alone when a row change still matches nothing', async () => {
    const matches = false;
    const rows = fakeRowsChangedEvent();
    const { view } = setup({ hasRows: () => Promise.resolve(matches), onRowsChanged: rows.event });
    await open();
    currentBox().type('zzz');
    await flush();
    expect(view.message).toBe('No matches for "zzz".');

    view.message = 'Starting backend…';
    rows.fire();
    await flush();
    expect(view.message).toBe('Starting backend…');
  });

  it('leaves another owner\'s message alone when a row change would otherwise have cleared it', async () => {
    let matches = false;
    const rows = fakeRowsChangedEvent();
    const { view } = setup({ hasRows: () => Promise.resolve(matches), onRowsChanged: rows.event });
    await open();
    currentBox().type('zzz');
    await flush();
    expect(view.message).toBe('No matches for "zzz".');

    view.message = 'Starting backend…';
    matches = true;
    rows.fire();
    await flush();
    expect(view.message).toBe('Starting backend…');
  });
});

describe('the Mods separator toggle rides on the box', () => {
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
