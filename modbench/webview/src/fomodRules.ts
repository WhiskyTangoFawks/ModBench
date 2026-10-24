// mods-fomod.md, Groups and options: what the reference installer's page shows of a group, and enforces.

import type { FomodGroup, FomodGroupType, FomodOption, FomodStep } from '../../src/wire/fomodPage';

/** The group's type as the reference installer takes it: a lone option cannot be a choice between several. */
export function effectiveGroupType(group: FomodGroup): FomodGroupType {
  if (group.options.length !== 1) return group.type;
  switch (group.type) {
    case 'SelectAtLeastOne':
    case 'SelectExactlyOne': return 'SelectAll';
    case 'SelectAtMostOne': return 'SelectAny';
    case 'SelectAll':
    case 'SelectAny': return group.type;
  }
}

/** Whether the option shows ticked: never a not usable one, whatever the engine selected. */
export const isPicked = (group: FomodGroup, option: FomodOption): boolean =>
  option.type !== 'NotUsable' && (option.selected || option.type === 'Required' || effectiveGroupType(group) === 'SelectAll');

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
