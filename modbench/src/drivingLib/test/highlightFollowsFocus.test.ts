import { describe, it, expect } from 'vitest';
import { createFocusedView } from '../focusedView';
import { highlightFollowingFocus, type DrawsHighlight } from '../highlightFollowsFocus';
import { FakeTreeView } from './nameFilterViewHarness';

type RelatedRows = Parameters<DrawsHighlight['highlight']>[0];
const HELD: RelatedRows = { plugins: [{ name: 'A.esp', origin: 'A' }] };

function harness() {
  const focused = createFocusedView();
  const mods = new FakeTreeView();
  const plugins = new FakeTreeView();
  focused.follow('mods', mods);
  focused.follow('plugins', plugins);
  const drawn: RelatedRows[] = [];
  const changed = new Set<() => void>();
  highlightFollowingFocus(
    focused, new Map([['mods', { related: (selection) => (selection.length > 0 ? HELD : { plugins: [] }) }]]),
    [{ highlight: (related) => { drawn.push(related); } }],
    (listener) => { changed.add(listener); return { dispose: () => { changed.delete(listener); } }; },
  );
  return { mods, plugins, drawn, changed };
}

describe('the highlight follows the view last selected in', () => {
  it('hands what the focused view relates its selection to', () => {
    const { mods, drawn } = harness();

    mods.selectRows(['a mod']);

    expect(drawn).toEqual([HELD]);
  });

  it('hands nothing after a selection in a view that relates nothing, though Mods still holds its selection', () => {
    const { mods, plugins, drawn } = harness();
    mods.selectRows(['a mod']);

    plugins.selectRows(['a plugin']);

    expect(mods.selection).toEqual(['a mod']);
    expect(drawn.at(-1)).toEqual({ plugins: [] });
  });

  it('hands the selection again when the rows it stands for change', () => {
    const { mods, drawn, changed } = harness();
    mods.selectRows(['a mod']);

    for (const listener of changed) listener();

    expect(drawn).toEqual([HELD, HELD]);
  });
});
