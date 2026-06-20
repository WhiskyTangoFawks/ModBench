import React from 'react';
import type { FieldMetadata } from './types';

interface FlagCellProps {
  value: unknown;
  meta: FieldMetadata;
  editMode: boolean;
  onCommit: (v: unknown) => void;
}

export function FlagCell({ value, meta, editMode, onCommit }: FlagCellProps) {
  if (meta.enumValues.length === 0) return null;
  if (!meta.enumBitValues) return null;

  const num = value == null ? 0 : Number(value);

  if (!editMode) {
    if (value == null) return <span style={{ opacity: 0.35 }}>—</span>;
    const active = meta.enumValues.filter((_, i) => (num & meta.enumBitValues![i]) !== 0);
    return <span>{active.join(', ') || '—'}</span>;
  }

  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px' }}>
      {meta.enumValues.map((name, i) => (
        <label key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <input
            type="checkbox"
            checked={(num & meta.enumBitValues![i]) !== 0}
            onChange={() => onCommit(num ^ meta.enumBitValues![i])}
          />
          {name}
        </label>
      ))}
    </span>
  );
}
