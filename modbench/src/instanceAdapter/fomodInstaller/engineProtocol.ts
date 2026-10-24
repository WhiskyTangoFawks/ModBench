// What the FOMOD installer and the process that runs the engine say to each other.

import type { types } from '@nexusmods/fomod-installer-native';

export type Known<T> = { readonly known: T } | { readonly unknown: string };

/** What a FOMOD's conditions read of the instance: each plugin present and each active, and the versions of the game
 *  and its script extender. */
export interface ConditionFacts {
  readonly plugins: Known<{ readonly present: readonly string[]; readonly active: readonly string[] }>;
  readonly gameVersion: Known<string>;
  readonly extenderVersion: Known<string>;
}

export interface Selection {
  readonly groupId: number;
  readonly optionIds: readonly number[];
}

export type EngineRequest =
  | { readonly kind: 'install'; readonly engineFolder: string; readonly root: string; readonly files: readonly string[]; readonly facts: ConditionFacts }
  | { readonly kind: 'select'; readonly stepId: number; readonly selection: Selection }
  | { readonly kind: 'continue'; readonly forward: boolean; readonly stepId: number }
  | { readonly kind: 'cancel' };

/** `dialog` is the installer opening, `step` its state after a change, `cause` that change: a selection, or a move.
 *  `failed` is an installer it cannot read, `broken` an engine that cannot run. */
export type EngineReport =
  | { readonly kind: 'dialog'; readonly module: string }
  | { readonly kind: 'step'; readonly steps: readonly types.IInstallStep[]; readonly current: number; readonly cause: 'select' | 'move' }
  | { readonly kind: 'unanswered'; readonly question: string; readonly why: string }
  | { readonly kind: 'done'; readonly result: types.InstallResult | null }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'broken'; readonly message: string };

// Both ends compile from these types into one package, so a message's kind is all there is to check.
const hasKind = (value: unknown): boolean => typeof value === 'object' && value !== null && 'kind' in value;

export const isRequest = (value: unknown): value is EngineRequest => hasKind(value);

export const isReport = (value: unknown): value is EngineReport => hasKind(value);
