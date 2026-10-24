import { describe, expect, it } from 'vitest';
import { present } from '../../ports/present';
import {
  groupsNeedingPick, hasPrevious, isLastVisible, isOptionLocked, isPicked, optionsAfterClick, parseFomodMove, parseFomodShown,
  type FomodGroup, type FomodGroupType, type FomodOption, type FomodStep,
} from '../fomodPage';

const option = (id: number, over: Partial<FomodOption> = {}): FomodOption =>
  ({ id, selected: false, name: `O${id}`, description: '', image: '', type: 'Optional', ...over });

const group = (type: FomodGroupType, ...options: FomodOption[]): FomodGroup => ({ id: 0, name: 'G', type, options });

const at = (from: FomodGroup, index: number): FomodOption => present(from.options[index], 'the option');

const step = (id: number, visible: boolean, ...groups: FomodGroup[]): FomodStep =>
  ({ id, name: `S${id}`, visible, optionalFileGroups: { group: groups } });

describe('a FOMOD group, as the reference installer shows it', () => {
  it('ticks what the engine selected, each required option, and every option of a group that takes all', () => {
    const takesAll = group('SelectAll', option(0), option(1));
    expect(takesAll.options.map((each) => isPicked(takesAll, each))).toEqual([true, true]);
    const any = group('SelectAny', option(0, { selected: true }), option(1, { type: 'Required' }), option(2));
    expect(any.options.map((each) => isPicked(any, each))).toEqual([true, true, false]);
  });

  it('locks a required option, an unusable one, and every option of a one-pick group that a required option forces', () => {
    const any = group('SelectAny', option(0, { type: 'Required' }), option(1), option(2, { type: 'NotUsable' }));
    expect(any.options.map((each) => isOptionLocked(any, each))).toEqual([true, false, true]);
    const exactlyOne = group('SelectExactlyOne', option(0, { type: 'Required' }), option(1));
    expect(exactlyOne.options.map((each) => isOptionLocked(exactlyOne, each))).toEqual([true, true]);
  });

  it('takes a lone option of a group that wants a pick as required, as the reference installer does', () => {
    const lone = group('SelectExactlyOne', option(0));
    expect(isPicked(lone, at(lone, 0))).toBe(true);
    expect(isOptionLocked(lone, at(lone, 0))).toBe(true);
  });

  it('replaces the pick of a one-pick group by a click, and toggles an option of a many-pick group', () => {
    const exactlyOne = group('SelectExactlyOne', option(0, { selected: true }), option(1));
    expect(optionsAfterClick(exactlyOne, at(exactlyOne, 1))).toEqual([1]);
    const any = group('SelectAny', option(0, { selected: true }), option(1));
    expect(optionsAfterClick(any, at(any, 1))).toEqual([0, 1]);
    expect(optionsAfterClick(any, at(any, 0))).toEqual([]);
  });

  it('refuses Next while a group that needs a pick has none, and no other group', () => {
    const bare = group('SelectAtLeastOne', option(0), option(1));
    const picked = group('SelectAtLeastOne', option(0, { selected: true }), option(1));
    const exactlyOne = group('SelectExactlyOne', option(0), option(1));
    expect(groupsNeedingPick(step(0, true, bare, picked, exactlyOne))).toEqual([bare]);
  });
});

describe('the steps of a FOMOD', () => {
  it('reads Install on the last step that is visible, whatever hidden steps follow', () => {
    const steps = [step(0, true), step(1, true), step(2, false)];
    expect(isLastVisible(steps, 0)).toBe(false);
    expect(isLastVisible(steps, 1)).toBe(true);
  });

  it('offers Back only after a visible step', () => {
    const steps = [step(0, false), step(1, true), step(2, true)];
    expect(hasPrevious(steps, 1)).toBe(false);
    expect(hasPrevious(steps, 2)).toBe(true);
  });
});

describe('the messages of the FOMOD page', () => {
  it('reads what the host shows and what the page sends, and nothing else', () => {
    const state = { module: 'M', steps: [], current: 0 };
    expect(parseFomodShown({ type: 'fomodState', state })?.state).toEqual(state);
    expect(parseFomodShown({ type: 'other', state })).toBeUndefined();
    expect(parseFomodMove({ type: 'fomodMove', move: { kind: 'manual' } })).toEqual({ kind: 'manual' });
    expect(parseFomodMove({ type: 'fomodMove', move: { kind: 'format' } })).toBeUndefined();
  });
});
