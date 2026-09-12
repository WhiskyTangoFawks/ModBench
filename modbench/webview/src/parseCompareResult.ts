import type { components } from '../../src/medit/generated/api';
import type { CompareResult } from './types';

type Schemas = components['schemas'];

/** The wire's `CompareResult`, narrowed to the webview's own closed refinement of
 *  `FieldMetadata.type` — a downcast by construction (the backend guarantees the closed set),
 *  not a validation. The one cast to that refinement. */
export function parseCompareResult(data: Schemas['CompareResult'] | undefined): CompareResult {
  return data as CompareResult;
}
