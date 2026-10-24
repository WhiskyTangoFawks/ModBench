// mods-fomod.md: what the FOMOD installer sends its page, what the page sends back, and the rules the page
// shows and enforces as the reference installer does.

export type FomodGroupType = 'SelectAtLeastOne' | 'SelectAtMostOne' | 'SelectExactlyOne' | 'SelectAll' | 'SelectAny';
type FomodOptionType = 'Required' | 'Optional' | 'Recommended' | 'NotUsable' | 'CouldBeUsable';

export interface FomodOption<Image = string> {
  readonly id: number;
  readonly selected: boolean;
  readonly name: string;
  readonly description: string;
  readonly image: Image;
  readonly type: FomodOptionType;
}

export interface FomodGroup<Image = string> {
  readonly id: number;
  readonly name: string;
  readonly type: FomodGroupType;
  readonly options: readonly FomodOption<Image>[];
}

export interface FomodStep<Image = string> {
  readonly id: number;
  readonly name: string;
  readonly visible: boolean;
  readonly optionalFileGroups?: { readonly group: readonly FomodGroup<Image>[] };
}

/** What the user did on the page. A selection names every option picked in the group, as the engine takes it. */
export type FomodMove =
  | { readonly kind: 'select'; readonly stepId: number; readonly groupId: number; readonly optionIds: readonly number[] }
  | { readonly kind: 'continue'; readonly forward: boolean; readonly stepId: number }
  | { readonly kind: 'manual' }
  | { readonly kind: 'cancel' };

/** A file of the extracted FOMOD, by its `/` path in it; none for an image the FOMOD omits or names outside itself. */
export type ReleaseImage = { readonly path: string } | undefined;

/** The installer as it stands: its header, every step with its visibility now, and the one the user is on. A header
 *  field the FOMOD does not give is empty. */
export interface FomodState<Image = string> {
  readonly module: string;
  readonly author: string;
  readonly version: string;
  readonly website: string;
  readonly image: Image;
  readonly steps: readonly FomodStep<Image>[];
  readonly current: number;
}

/** The state with each image, the header's and every option's, replaced by what `to` makes of it. */
export const withImages = <From, To>(state: FomodState<From>, to: (image: From) => To): FomodState<To> => ({
  ...state,
  image: to(state.image),
  steps: state.steps.map((step) => ({
    ...step,
    optionalFileGroups: step.optionalFileGroups && {
      group: step.optionalFileGroups.group.map((group) => ({ ...group, options: group.options.map((option) => ({ ...option, image: to(option.image) })) })),
    },
  })),
});

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

// Shallow: the state is the host's own build, trusted once the envelope checks out.
const isState = (value: unknown): value is FomodState => isObject(value) && Array.isArray(Reflect.get(value, 'steps'));

export function parseFomodShown(value: unknown): FomodShown | undefined {
  if (!isObject(value) || Reflect.get(value, 'type') !== FOMOD_STATE) return undefined;
  const state: unknown = Reflect.get(value, 'state');
  return isState(state) ? { type: FOMOD_STATE, state } : undefined;
}

export const isFomodReady = (value: unknown): boolean => isObject(value) && Reflect.get(value, 'type') === FOMOD_READY;

export function parseFomodMove(value: unknown): FomodMove | undefined {
  if (!isObject(value) || Reflect.get(value, 'type') !== FOMOD_MOVE) return undefined;
  const move: unknown = Reflect.get(value, 'move');
  return isMove(move) ? move : undefined;
}
