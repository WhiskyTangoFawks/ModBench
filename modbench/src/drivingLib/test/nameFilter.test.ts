import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  filterBoxCommandsMock, filterBoxWindowMock, currentBoxOf, type FilterBoxState,
} from './nameFilterViewHarness';

const h = vi.hoisted(() => {
  const state: FilterBoxState & { contextKeys: Map<string, unknown> } = {
    commands: new Map(), contextKeys: new Map(), boxes: [],
  };
  return { state, statusBar: [] as unknown[][] };
});

vi.mock('vscode', () => ({
  window: { ...filterBoxWindowMock(h.state), setStatusBarMessage: (...args: unknown[]) => { h.statusBar.push(args); } },
  commands: {
    ...filterBoxCommandsMock(h.state),
    executeCommand: (command: string, ...args: unknown[]) => {
      if (command === 'setContext' && typeof args[0] === 'string') h.state.contextKeys.set(args[0], args[1]);
      return Promise.resolve(h.state.commands.get(command)?.(...args));
    },
  },
  ThemeIcon: class { constructor(public id: string) {} },
}));

import { registerFilterCommands, registerNameFilter } from '../nameFilter';
import { present } from '../../ports/present';

const OBJECT = 'test.thing';
const KEY = `${OBJECT}.filterActive`;

interface Harness {
  view: { description?: string; message?: string };
  applied: { text: string; toggleOn: boolean }[];
  filter: ReturnType<typeof registerNameFilter>;
}

let current: ReturnType<typeof registerNameFilter>;

function setup(overrides: Partial<Parameters<typeof registerNameFilter>[0]> = {}): Harness {
  const view: { description?: string; message?: string } = {};
  const applied: { text: string; toggleOn: boolean }[] = [];
  const filter = current = registerNameFilter({
    view,
    object: OBJECT,
    placeholder: 'Filter things…',
    setFilter: (text, toggleOn) => applied.push({ text, toggleOn }),
    hasRows: () => Promise.resolve(true),
    ...overrides,
  });
  return { view, applied, filter };
}

const open = () => { current.open(); };
const clear = () => { current.clear(); };

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
const currentBox = currentBoxOf(h.state);
const fixedWindow = () => new Promise((resolve) => setImmediate(resolve));
const shows = (view: { message?: string }, message: string | undefined) => vi.waitFor(() => { expect(view.message).toBe(message); });

function probedMessages(viewMessage?: string) {
  const probe = { asked: 0 };
  const ask = () => { probe.asked++; return viewMessage; };
  return { probe, viewMessage: ask, standingMessage: () => { probe.asked++; return undefined; } };
}
const rendered = (probe: { asked: number }, times: number) => vi.waitFor(() => { expect(probe.asked).toBe(times); });

beforeEach(() => {
  h.state.commands.clear();
  h.state.contextKeys.clear();
  h.state.boxes.length = 0;
});

describe('the name filter is durable', () => {
  it('keeps the filter applied when the box hides — Enter, Escape and clicking a row are one API event, and none of them is an intent to discard', () => {
    const { applied } = setup();
    open();
    currentBox().type('arm');
    currentBox().hide();
    expect(applied.map((a) => a.text)).toEqual(['arm']);
  });

  it('disposes the hidden box — the widget is an entry mechanism, not where the filter lives', () => {
    setup();
    open();
    currentBox().hide();
    expect(currentBox().disposed).toBe(true);
  });

  it('reopens prefilled with the active term, so the box edits the filter rather than starting over', () => {
    setup();
    open();
    currentBox().type('arm');
    currentBox().hide();
    open();
    expect(currentBox().value).toBe('arm');
  });

  it('clears only on the explicit clear command', () => {
    const { applied } = setup();
    open();
    currentBox().type('arm');
    currentBox().hide();
    clear();
    expect(applied.map((a) => a.text)).toEqual(['arm', '']);
  });

  it('raises the filter-active context key while filtered and drops it on clear, driving the slot-1 icon swap', () => {
    setup();
    open();
    currentBox().type('arm');
    currentBox().hide();
    expect(h.state.contextKeys.get(KEY)).toBe(true);
    clear();
    expect(h.state.contextKeys.get(KEY)).toBe(false);
  });

  it('lowers a filter-active context key left over from an earlier extension host as it registers', () => {
    h.state.contextKeys.set(KEY, true);
    setup();
    expect(h.state.contextKeys.get(KEY)).toBe(false);
  });

  it('treats a term typed back to empty as no filter, without needing the clear command', () => {
    setup();
    open();
    currentBox().type('arm');
    currentBox().type('');
    expect(h.state.contextKeys.get(KEY)).toBe(false);
  });
});

describe('the active term reads out in the view description', () => {
  it.each<[string, Partial<Parameters<typeof registerNameFilter>[0]>, string | undefined, string, string | undefined]>([
    ['the term alone, so the user sees what they are filtered by', {}, undefined, 'arm', '"arm"'],
    ['the term first, then the base', {}, 'Default', 'arm', '"arm" · Default'],
    ['the term after the base where the view reads its base first', { termPlacement: 'afterBase' }, '12 / 30', 'arm', '12 / 30 · "arm"'],
    ['the base alone while no filter is active', {}, 'Default', '', 'Default'],
    ['nothing when no filter is active and the view has no base', {}, undefined, '', undefined],
  ])('says %s', (_what, overrides, base, typed, said) => {
    const { view, filter } = setup(overrides);
    filter.setBaseDescription(base);
    open();
    currentBox().type(typed);
    expect(view.description).toBe(said);
  });

  it('says nothing once the filter is cleared', () => {
    const { view } = setup();
    open();
    currentBox().type('arm');
    clear();
    expect(view.description).toBeUndefined();
  });

  it('recomposes when the record filter\'s base changes under a live name filter, leaving the name half standing', () => {
    const { view, filter } = setup();
    open();
    currentBox().type('arm');
    filter.setBaseDescription('records: cells.sql');
    expect(view.description).toBe('"arm" · records: cells.sql');
    filter.setBaseDescription(undefined);
    expect(view.description).toBe('"arm"');
  });
});

describe('a term that matches nothing says so', () => {
  it.each([
    ['names the term rather than leaving a bare empty tree, which reads as "there is nothing here"', false, 'zzz', 'No matches for "zzz".'],
    ['says nothing while rows match, an error row that survives the filter included', true, 'arm', undefined],
  ])('%s', async (_what, rowsMatch, term, said) => {
    const { probe, ...messages } = probedMessages();
    const { view } = setup({ hasRows: () => Promise.resolve(rowsMatch), ...messages });
    open();
    currentBox().type(term);
    await rendered(probe, 1);
    expect(view.message).toBe(said);
  });

  it('takes the message back down when the filter is cleared', async () => {
    const { view } = setup({ hasRows: () => Promise.resolve(false) });
    open();
    currentBox().type('zzz');
    await shows(view, 'No matches for "zzz".');
    clear();
    await shows(view, undefined);
  });

  it('restates its message on refresh, once the caller has handed the blanked line back', async () => {
    const { view, filter } = setup({ hasRows: () => Promise.resolve(false) });
    open();
    currentBox().type('zzz');
    await shows(view, 'No matches for "zzz".');
    view.message = 'Loading plugins…';
    view.message = undefined;
    filter.refresh();
    await shows(view, 'No matches for "zzz".');
  });

  it('leaves the message alone when no filter is active — the view has other things to say', async () => {
    const { view } = setup({ hasRows: () => Promise.resolve(false) });
    view.message = 'Loading plugins…';
    open();
    currentBox().hide();
    await fixedWindow();
    expect(view.message).toBe('Loading plugins…');
  });
});

describe('the view\'s own message', () => {
  it('shows it on a row change, gives way to the no-match message while filtering, and returns once the filter clears', async () => {
    const rows = fakeRowsChangedEvent();
    const { view } = setup({
      hasRows: () => Promise.resolve(false), onRowsChanged: rows.event, viewMessage: () => 'Nothing here yet.',
    });
    rows.fire();
    await shows(view, 'Nothing here yet.');

    open();
    currentBox().type('zzz');
    await shows(view, 'No matches for "zzz".');

    clear();
    await shows(view, 'Nothing here yet.');
  });

  it('keeps the standing message beside the no-match message while a filter matches nothing', async () => {
    const rows = fakeRowsChangedEvent();
    const { view } = setup({
      hasRows: () => Promise.resolve(false), onRowsChanged: rows.event,
      viewMessage: () => 'Showing the last good read: EACCES', standingMessage: () => 'Showing the last good read: EACCES',
    });

    open();
    currentBox().type('zzz');

    await shows(view, 'No matches for "zzz". Showing the last good read: EACCES');
  });

  it('takes it down once the view has something to show', async () => {
    let message: string | undefined = 'Nothing here yet.';
    const rows = fakeRowsChangedEvent();
    const { view } = setup({ onRowsChanged: rows.event, viewMessage: () => message });
    rows.fire();
    await shows(view, 'Nothing here yet.');

    message = undefined;
    rows.fire();
    await shows(view, undefined);
  });

  it('keeps it standing while a filter matches rows', async () => {
    const rows = fakeRowsChangedEvent();
    const { probe, ...messages } = probedMessages('Something is missing.');
    const { view } = setup({ onRowsChanged: rows.event, ...messages });
    rows.fire();
    await rendered(probe, 1);

    open();
    currentBox().type('thing');
    await rendered(probe, 2);
    expect(view.message).toBe('Something is missing.');
  });

  it('states it on refresh, with no row change', async () => {
    const { view, filter } = setup({ viewMessage: () => 'Nothing here yet.' });
    filter.refresh();
    await shows(view, 'Nothing here yet.');
  });
});

describe('the message follows the view\'s own row-change signal', () => {
  it('recomputes in both directions off onRowsChanged alone, with a keystroke setting the term once beforehand', async () => {
    let matches = false;
    const rows = fakeRowsChangedEvent();
    const { view } = setup({ hasRows: () => Promise.resolve(matches), onRowsChanged: rows.event });
    open();
    currentBox().type('zzz');
    await shows(view, 'No matches for "zzz".');

    matches = true;
    rows.fire();
    await shows(view, undefined);

    matches = false;
    rows.fire();
    await shows(view, 'No matches for "zzz".');
  });

  it('does nothing while no filter is active — a provider free to fire whenever must not conjure a message', async () => {
    const rows = fakeRowsChangedEvent();
    const { probe, ...messages } = probedMessages();
    const { view } = setup({ hasRows: () => Promise.resolve(false), onRowsChanged: rows.event, ...messages });
    rows.fire();
    await rendered(probe, 1);
    expect(view.message).toBeUndefined();
  });

  it('stops recomputing once the filter is disposed, alongside its commands', async () => {
    let matches = false;
    const rows = fakeRowsChangedEvent();
    const { view, filter } = setup({ hasRows: () => Promise.resolve(matches), onRowsChanged: rows.event });
    open();
    currentBox().type('zzz');
    await shows(view, 'No matches for "zzz".');

    filter.dispose();
    matches = true;
    rows.fire();
    await fixedWindow();
    expect(view.message).toBe('No matches for "zzz".');
  });

  it.each([
    ['still matches nothing', false],
    ['would otherwise have cleared it', true],
  ])('leaves another owner\'s message alone when a row change %s', async (_what, matchesAfter) => {
    let matches = false;
    const rows = fakeRowsChangedEvent();
    const { probe, ...messages } = probedMessages();
    const { view } = setup({ hasRows: () => Promise.resolve(matches), onRowsChanged: rows.event, ...messages });
    open();
    currentBox().type('zzz');
    await shows(view, 'No matches for "zzz".');

    view.message = 'Starting backend…';
    matches = matchesAfter;
    rows.fire();
    await rendered(probe, 2);
    expect(view.message).toBe('Starting backend…');
  });
});

describe('the Mods separator toggle rides on the box', () => {
  const toggle = { icon: 'list-tree', label: 'Group by separator' };

  it('reapplies the current term when the toggle is pressed, so the option takes effect without retyping', () => {
    const { applied } = setup({ toggle });
    open();
    currentBox().type('arm');
    currentBox().pressButton();
    expect(applied).toEqual([{ text: 'arm', toggleOn: true }, { text: 'arm', toggleOn: false }]);
  });

  it('keeps the toggle state across a reopen, since the filter it belongs to survived the hide', () => {
    const { applied } = setup({ toggle });
    open();
    currentBox().type('arm');
    currentBox().pressButton();
    currentBox().hide();
    open();
    currentBox().type('armor');
    expect(applied.at(-1)).toEqual({ text: 'armor', toggleOn: false });
  });

  it('returns to grouped when the term is typed back to empty, so the next term starts grouped', () => {
    const { applied } = setup({ toggle });
    open();
    currentBox().type('arm');
    currentBox().pressButton();
    currentBox().type('');
    currentBox().type('w');
    expect(applied.slice(-2)).toEqual([{ text: '', toggleOn: true }, { text: 'w', toggleOn: true }]);
  });

  it('shows the toggle as on again once the term is typed back to empty', () => {
    setup({ toggle });
    open();
    currentBox().type('arm');
    currentBox().pressButton();
    currentBox().type('');
    expect(currentBox().buttons.map((b) => b.tooltip)).toEqual(['Group by separator (on)']);
  });

  it('resets the toggle to on when the filter is cleared', () => {
    const { applied } = setup({ toggle });
    open();
    currentBox().type('arm');
    currentBox().pressButton();
    clear();
    expect(applied.at(-1)).toEqual({ text: '', toggleOn: true });
  });
});

describe('the catalog\'s filter pair acts on the focused view\'s filter', () => {
  const filterOf = (calls: string[], name: string) => ({
    open: () => { calls.push(`${name} open`); },
    clear: () => { calls.push(`${name} clear`); },
  });

  function wire(focused: string | undefined) {
    const calls: string[] = [];
    h.statusBar.length = 0;
    registerFilterCommands(
      () => focused,
      new Map([['view.a', filterOf(calls, 'a')], ['view.b', filterOf(calls, 'b')]]),
    );
    return { calls, run: (id: string) => { void present(h.state.commands.get(id), id)(); } };
  }

  it.each<[string, string | undefined, string, string[]]>([
    ['opens the focused view\'s box, and no other\'s', 'view.b', 'modbench.filter', ['b open']],
    ['clears the focused view\'s filter, and no other\'s', 'view.a', 'modbench.clearFilter', ['a clear']],
    ['opens the filter of the view whose title icon was clicked, whichever view was last selected in', 'view.a', 'view.b.filterHere', ['b open']],
    ['clears the filter of the view whose title icon was clicked, whichever view was last selected in', 'view.a', 'view.b.clearFilterHere', ['b clear']],
    ['says so when open finds a focused view with no name filter', 'view.elsewhere', 'modbench.filter', ['Focus a list to filter it. | 5000']],
    ['says so when clear finds a focused view with no name filter', 'view.elsewhere', 'modbench.clearFilter', ['Focus a list to filter it. | 5000']],
    ['says so when open finds no view focused', undefined, 'modbench.filter', ['Focus a list to filter it. | 5000']],
    ['says so when clear finds no view focused', undefined, 'modbench.clearFilter', ['Focus a list to filter it. | 5000']],
  ])('%s', (_what, focused, command, expected) => {
    const { calls, run } = wire(focused);
    run(command);
    expect([...calls, ...h.statusBar.map((args) => args.join(' | '))]).toEqual(expected);
  });
});
