import type { components } from '../../src/wire/generated/api';

type WireSchemas = components['schemas'];

// Enforced by `tsc --noEmit`: every export below is a type, checked at compile time, never at
// runtime. Not named `*.test.ts` — vitest transpiles with esbuild and strips types unchecked.

// `Exact` is a bidirectional-extends pair rather than a bare `extends`, because
// `string extends string | null | undefined` is true, so a one-way check would pass against the
// very shape this exists to reject.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// A non-nullable C# `string Name` is a required, non-nullable wire property.
export type CheckNonNullableIsRequired = Assert<Exact<WireSchemas['PluginResponse']['name'], string>>;

// A genuinely nullable C# member must not be swept into `required`: a filter marking every
// property required would pass the check above and fail this one.
export type CheckHonestNullableSurvives =
  Assert<Exact<WireSchemas['PluginResponse']['loadOrderIndex'], number | null | undefined>>;

// An enum the global JsonStringEnumConverter serializes as a string must be described as one.
export type CheckWireEnumIsStringUnion =
  Assert<Exact<WireSchemas['WorkingTreeState'], 'None' | 'Modified' | 'Added'>>;
