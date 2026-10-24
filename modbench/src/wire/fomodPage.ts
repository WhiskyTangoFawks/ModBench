// mods-fomod.md: what the FOMOD installer sends its page, what the page sends back, and the rules the page
// shows and enforces as the reference installer does.

import type { types } from '@nexusmods/fomod-installer-native';

export type FomodStep = types.IInstallStep;
export type FomodGroup = types.IGroup;
export type FomodOption = types.IPlugin;

/** What the user did on the page. A selection names every option picked in the group, as the engine takes it. */
export type FomodMove =
  | { readonly kind: 'select'; readonly stepId: number; readonly groupId: number; readonly optionIds: readonly number[] }
  | { readonly kind: 'continue'; readonly forward: boolean; readonly stepId: number }
  | { readonly kind: 'manual' }
  | { readonly kind: 'cancel' };

/** The installer as it stands: every step with its visibility now, and the one the user is on. */
export interface FomodState {
  readonly module: string;
  readonly steps: readonly FomodStep[];
  readonly current: number;
}

export const FOMOD_STATE = 'fomodState';
// The page's listener exists only once its script has run, so the host answers this rather than posting into a page
// that cannot hear it.
export const FOMOD_READY = 'fomodReady';
export const FOMOD_MOVE = 'fomodMove';

export interface FomodShown {
  readonly type: typeof FOMOD_STATE;
  readonly state: FomodState;
}

export type FomodPageMessage = { readonly type: typeof FOMOD_READY } | { readonly type: typeof FOMOD_MOVE; readonly move: FomodMove };

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const isMove = (value: unknown): value is FomodMove => isObject(value) && ['select', 'continue', 'manual', 'cancel'].includes(String(Reflect.get(value, 'kind')));

export function parseFomodShown(value: unknown): FomodShown | undefined {
  if (!isObject(value) || Reflect.get(value, 'type') !== FOMOD_STATE) return undefined;
  const state: unknown = Reflect.get(value, 'state');
  return isObject(state) && Array.isArray(Reflect.get(state, 'steps')) ? { type: FOMOD_STATE, state: state as FomodState } : undefined;
}

export const isFomodReady = (value: unknown): boolean => isObject(value) && Reflect.get(value, 'type') === FOMOD_READY;

export function parseFomodMove(value: unknown): FomodMove | undefined {
  if (!isObject(value) || Reflect.get(value, 'type') !== FOMOD_MOVE) return undefined;
  const move: unknown = Reflect.get(value, 'move');
  return isMove(move) ? move : undefined;
}

/** The group's type as the reference installer takes it: a lone option cannot be a choice between several. */
export function effectiveGroupType(group: FomodGroup): types.GroupType {
  if (group.options.length !== 1) return group.type;
  switch (group.type) {
    case 'SelectAtLeastOne':
    case 'SelectExactlyOne': return 'SelectAll';
    case 'SelectAtMostOne': return 'SelectAny';
    default: return group.type;
  }
}

/** Whether the option shows ticked. */
export const isPicked = (group: FomodGroup, option: FomodOption): boolean =>
  option.selected || option.type === 'Required' || effectiveGroupType(group) === 'SelectAll';

/** Whether the user may change the option: not a required or unusable one, and not any option of a group that a
 *  required option forces or that takes all. */
export function isOptionLocked(group: FomodGroup, option: FomodOption): boolean {
  const type = effectiveGroupType(group);
  if (type === 'SelectAll' || option.type === 'NotUsable' || option.type === 'Required') return true;
  const oneOnly = type === 'SelectExactlyOne' || type === 'SelectAtMostOne';
  return oneOnly && group.options.some(({ type: each }) => each === 'Required');
}

/** The options a group holds after the user clicks one. */
export function optionsAfterClick(group: FomodGroup, clicked: FomodOption): readonly number[] {
  const type = effectiveGroupType(group);
  if (type === 'SelectExactlyOne' || type === 'SelectAtMostOne') return [clicked.id];
  const kept = group.options.filter((option) => option.id !== clicked.id && isPicked(group, option)).map(({ id }) => id);
  return isPicked(group, clicked) ? kept : [...kept, clicked.id];
}

/** The groups of the step that lack the pick Next needs. */
export const groupsNeedingPick = (step: FomodStep): readonly FomodGroup[] =>
  (step.optionalFileGroups?.group ?? []).filter((group) =>
    effectiveGroupType(group) === 'SelectAtLeastOne' && !group.options.some((option) => isPicked(group, option)));

/** Whether the step is the last the user can see now. */
export const isLastVisible = (steps: readonly FomodStep[], current: number): boolean =>
  !steps.slice(current + 1).some(({ visible }) => visible);

/** The step the user came from: the nearest visible one before the current. */
export const hasPrevious = (steps: readonly FomodStep[], current: number): boolean =>
  steps.slice(0, current).some(({ visible }) => visible);
