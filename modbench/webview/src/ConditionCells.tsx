import React from 'react';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import type { FieldMetadata, FormKeyResolution, ParsedConditionParam } from './types';

// Issue #231: the four `renderCell` dispatch targets for Condition's composite leaf types —
// each picks its own widget from its own current value's shape, rather than a second per-plugin
// metadata branch DiffRow would otherwise need.
//
// #410/ADR-0041: read-only. The function QuickPick and the inline editors behind these cells all
// staged through endpoints that are gone; what a condition *says* is unchanged, and it is still
// rendered in xEdit's own shape.

function enumMeta(enumValues: string[]): FieldMetadata {
  return { name: '', type: 'enum', isArray: false, validFormKeyTypes: [], enumValues };
}
function scalarMeta(type: 'string' | 'int' | 'float' | 'bool'): FieldMetadata {
  return { name: '', type, isArray: false, validFormKeyTypes: [], enumValues: [] };
}
function formKeyMeta(validFormKeyTypes: string[] = []): FieldMetadata {
  return { name: '', type: 'formKey', isArray: false, validFormKeyTypes, enumValues: [] };
}


interface CompositeCellProps {
  value: unknown;
  isFocused?: boolean;
}

export function ConditionFunctionCell({ value }: Readonly<CompositeCellProps>) {
  const fn = typeof value === 'string' ? value : '';
  return <span>{fn || <span style={{ opacity: 0.35 }}>—</span>}</span>;
}

interface RunOnValue { target: string; reference: string | null }

// Issue #167: `meta.enumValues` is the server's Run On target catalog (GET
// /condition-run-on-targets, threaded in by conditionTreeAdapter's `runOnMeta`) — no hardcoded
// FO4 member list here anymore, so a future game's differently-shaped RunOnType enum offers
// exactly what it resolves, never a name it can't parse or write.
// resolution (#166): ADR-0031's FormKey→EditorID signal for the Reference FormKey, sourced from
// conditionTreeAdapter's `fieldResolutions["runOn"][plugin]` via DiffRow's existing generic
// per-leaf resolution pass-through — same prop FormKeyCell already accepts for the generic field
// path (FormKeyCell.tsx).
export function ConditionRunOnCell({ value, meta, isFocused, onOpen, resolution }: Readonly<CompositeCellProps & { meta: FieldMetadata; onOpen: (fk: string) => void; resolution?: FormKeyResolution }>) {
  const v = (value ?? { target: 'Subject', reference: null }) as RunOnValue;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <ScalarCell value={v.target} meta={enumMeta(meta.enumValues)} />
      {v.target === 'Reference' && (
        <FormKeyCell
          value={v.reference} meta={formKeyMeta()} isFocused={isFocused}
          onOpen={onOpen} resolution={resolution}
        />
      )}
    </span>
  );
}

// A bare scalar — the wire value is exactly what the backend's Comparison subfield already
// expects (a plain float, or a plain GLOB FormKey string when UseGlobal), no wrapper object, so
// this infers which widget to show from the value's own JS type rather than a sibling UseGlobal
// flag this row has no access to (each condition field commits independently, #231's own "wire
// paths differ" friction — there is no single parent object here to read a sibling off of).
export function ConditionComparisonCell({ value, isFocused, onOpen, resolution }: Readonly<CompositeCellProps & { onOpen: (fk: string) => void; resolution?: FormKeyResolution }>) {
  if (typeof value === 'string') {
    return (
      <FormKeyCell
        value={value} meta={formKeyMeta(['glob'])} isFocused={isFocused}
        onOpen={onOpen} resolution={resolution}
      />
    );
  }
  return (
    <ScalarCell value={typeof value === 'number' ? value : 0} meta={scalarMeta('float')} />
  );
}

export function ConditionParamCell({ value, isFocused, onOpen, resolution }: Readonly<CompositeCellProps & { onOpen: (fk: string) => void; resolution?: FormKeyResolution }>) {
  const p = value as ParsedConditionParam | null;
  if (!p) return <span style={{ opacity: 0.35 }}>—</span>;
  const typeCue = <span style={{ opacity: 0.6 }}>&nbsp;({p.typeName})</span>;
  if (p.category === 'Form') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <FormKeyCell value={p.formKey} meta={formKeyMeta()} isFocused={isFocused} onOpen={onOpen} resolution={resolution} />
        {typeCue}
      </span>
    );
  }
  if (p.category === 'Text') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <ScalarCell value={p.text ?? ''} meta={scalarMeta('string')} />
        {typeCue}
      </span>
    );
  }
  // Issue #165: once DecodeParamValue resolves a name, xEdit's own wbConditionToStr shows only
  // that name (e.g. "Male") — no raw value, no (TypeName) suffix (matches its own summary text
  // exactly). Editing still targets the raw number unchanged (ScalarCell.displayOverride only
  // substitutes the resting label).
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <ScalarCell
        value={p.number ?? 0} meta={scalarMeta('int')} displayOverride={p.decodedValue ?? undefined}
      />
      {p.decodedValue == null && typeCue}
    </span>
  );
}

