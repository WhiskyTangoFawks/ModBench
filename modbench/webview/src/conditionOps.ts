// Condition-list defaults (#153). The structural add/remove/move ops themselves (ConditionListOp,
// applyConditionListOp, currentConditionList, overlayPendingEdits/overlayField/overlayParam) were
// this module's own bespoke machinery before #231 — deleted there once the condition list became
// an ordinary `type: 'array'` row (conditionTreeAdapter.ts), reusing the generic array-op
// machinery (recordUtils.ts's array mutation helpers) instead of a parallel condition-specific
// path. defaultCondition() is the one piece that still has a live caller: the generic array Add's
// `elementType.defaultValue`.
import type { ParsedCondition } from './types';

// Sensible defaults for a newly-added condition (#153 AC1: "appearing with sensible defaults and
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
