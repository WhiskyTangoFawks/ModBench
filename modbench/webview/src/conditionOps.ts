// Condition-list defaults. Structural add/remove/move goes through the generic array-op
// machinery (conditionTreeAdapter.ts + recordUtils.ts); defaultCondition() is consumed as the
// generic array Add's `elementType.defaultValue`.
import type { ParsedCondition } from './types';

// Sensible defaults for a newly-added condition ("appearing with sensible defaults and
// immediately editable"). GetIsID takes no parameters, so no parameter slots need populating.
export function defaultCondition(): ParsedCondition {
  return {
    function: 'GetIsID',
    operator: 'EqualTo',
    or: false,
    runOnTarget: 'Subject',
    runOnReference: null,
    useGlobal: false,
    comparisonFloat: 0,
    comparisonGlobal: null,
    parameters: [],
  };
}
