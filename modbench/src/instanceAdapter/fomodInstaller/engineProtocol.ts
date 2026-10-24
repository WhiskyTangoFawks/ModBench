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

export type EngineRequest =
  | { readonly kind: 'install'; readonly engineFolder: string; readonly root: string; readonly files: readonly string[]; readonly facts: ConditionFacts }
  | { readonly kind: 'select'; readonly stepId: number; readonly groupId: number; readonly optionIds: readonly number[] }
  | { readonly kind: 'continue'; readonly stepId: number }
  | { readonly kind: 'cancel' };

export type EngineReport =
  | { readonly kind: 'step'; readonly steps: readonly types.IInstallStep[]; readonly current: number }
  | { readonly kind: 'unanswered'; readonly question: string; readonly why: string }
  | { readonly kind: 'done'; readonly result: types.InstallResult | null }
  | { readonly kind: 'failed'; readonly message: string };
