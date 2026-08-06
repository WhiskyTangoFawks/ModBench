import React from 'react';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { pickConditionFunction } from './nativeBridge';
import { mono, fg } from './gridStyles';
import type { FieldMetadata, ParsedConditionParam } from './types';

// Issue #231: the four `renderCell` dispatch targets for Condition's composite leaf types —
// `conditionFunction` opens a QuickPick over the function catalogue (never a text/dropdown
// editor); `conditionRunOn`/`conditionComparison`/`conditionParam` each pick their own widget from
// their own current value's shape, the same pattern #229's VmadObjectEditor established, rather
// than a second per-plugin metadata branch DiffRow would otherwise need. All four gate their own
// click-to-open on `editable && isFocused`, matching FormKeyCell's identical gate, and carry
// `data-open-trigger` so F2 (DiskCell) reaches them the same way it reaches every other leaf.

function enumMeta(enumValues: string[]): FieldMetadata {
  return { name: '', type: 'enum', isArray: false, validFormKeyTypes: [], enumValues };
}
function scalarMeta(type: 'string' | 'int' | 'float' | 'bool'): FieldMetadata {
  return { name: '', type, isArray: false, validFormKeyTypes: [], enumValues: [] };
}
function formKeyMeta(validFormKeyTypes: string[] = []): FieldMetadata {
  return { name: '', type: 'formKey', isArray: false, validFormKeyTypes, enumValues: [] };
}

const functionButtonStyle: React.CSSProperties = {
  background: 'var(--vscode-input-background, #3c3c3c)',
  border: '1px solid var(--vscode-input-border, #555)',
  color: fg,
  cursor: 'pointer',
  fontFamily: mono,
  fontSize: '12px',
  padding: '1px 4px',
};

interface CompositeCellProps {
  value: unknown;
  editable: boolean;
  isFocused?: boolean;
  onCommit: (v: unknown) => void;
}

export function ConditionFunctionCell({ value, editable, isFocused = true, onCommit }: Readonly<CompositeCellProps>) {
  const fn = typeof value === 'string' ? value : '';
  if (!editable) return <span>{fn || <span style={{ opacity: 0.35 }}>—</span>}</span>;
  return (
    <button
      type="button"
      onClick={() => { if (isFocused) void pickConditionFunction(fn).then(picked => { if (picked) onCommit(picked); }); }}
      data-open-trigger
      style={functionButtonStyle}
    >
      {fn || <span style={{ opacity: 0.5 }}>— click to pick</span>}
    </button>
  );
}

interface RunOnValue { target: string; reference: string | null }

// Issue #167: `meta.enumValues` is the server's Run On target catalog (GET
// /condition-run-on-targets, threaded in by conditionTreeAdapter's `runOnMeta`) — no hardcoded
// FO4 member list here anymore, so a future game's differently-shaped RunOnType enum offers
// exactly what it resolves, never a name it can't parse or write.
export function ConditionRunOnCell({ value, meta, editable, isFocused, onCommit, onOpen }: Readonly<CompositeCellProps & { meta: FieldMetadata; onOpen: (fk: string) => void }>) {
  const v = (value ?? { target: 'Subject', reference: null }) as RunOnValue;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <ScalarCell
        value={v.target} meta={enumMeta(meta.enumValues)} editable={editable} isFocused={isFocused}
        onCommit={target => onCommit({ target, reference: target === 'Reference' ? v.reference : null })}
      />
      {v.target === 'Reference' && (
        <FormKeyCell
          value={v.reference} meta={formKeyMeta()} editable={editable} isFocused={isFocused}
          onOpen={onOpen} onCommit={fk => onCommit({ target: v.target, reference: fk })}
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
export function ConditionComparisonCell({ value, editable, isFocused, onCommit, onOpen }: Readonly<CompositeCellProps & { onOpen: (fk: string) => void }>) {
  if (typeof value === 'string') {
    return (
      <FormKeyCell
        value={value} meta={formKeyMeta(['glob'])} editable={editable} isFocused={isFocused}
        onOpen={onOpen} onCommit={onCommit}
      />
    );
  }
  return (
    <ScalarCell value={typeof value === 'number' ? value : 0} meta={scalarMeta('float')} editable={editable} isFocused={isFocused} onCommit={onCommit} />
  );
}

export function ConditionParamCell({ value, editable, isFocused, onCommit, onOpen }: Readonly<CompositeCellProps & { onOpen: (fk: string) => void }>) {
  const p = value as ParsedConditionParam | null;
  if (!p) return <span style={{ opacity: 0.35 }}>—</span>;
  const typeCue = <span style={{ opacity: 0.6 }}>&nbsp;({p.typeName})</span>;
  if (p.category === 'Form') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <FormKeyCell value={p.formKey} meta={formKeyMeta()} editable={editable} isFocused={isFocused} onOpen={onOpen} onCommit={onCommit} />
        {typeCue}
      </span>
    );
  }
  if (p.category === 'Text') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <ScalarCell value={p.text ?? ''} meta={scalarMeta('string')} editable={editable} isFocused={isFocused} onCommit={onCommit} />
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
        value={p.number ?? 0} meta={scalarMeta('int')} editable={editable} isFocused={isFocused}
        onCommit={onCommit} displayOverride={p.decodedValue ?? undefined}
      />
      {p.decodedValue == null && typeCue}
    </span>
  );
}

