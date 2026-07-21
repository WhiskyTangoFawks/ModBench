import React, { useState } from 'react';
import { toStr } from './recordUtils';
import { mono, fg } from './gridStyles';

export interface VmadScalarEditorProps {
  value: unknown;
  type: 'bool' | 'int' | 'float' | 'string';
  onCommit: (v: unknown) => void;
  ariaLabel?: string;
}

export function VmadScalarEditor({ value, type, onCommit, ariaLabel }: Readonly<VmadScalarEditorProps>) {
  const [draft, setDraft] = useState(() => toStr(value));
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(toStr(value));
  }

  if (type === 'bool') {
    return (
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={draft === 'true'}
        onChange={e => { setDraft(String(e.target.checked)); onCommit(e.target.checked); }}
      />
    );
  }

  function coerce(): unknown {
    if (type === 'int') { const n = Number.parseInt(draft, 10); return Number.isNaN(n) ? value : n; }
    if (type === 'float') { const n = Number.parseFloat(draft); return Number.isNaN(n) ? value : n; }
    return draft;
  }

  const inputStyle: React.CSSProperties = {
    fontFamily: mono,
    fontSize: '12px',
    background: 'var(--vscode-input-background, #3c3c3c)',
    color: fg,
    border: '1px solid var(--vscode-input-border, #555)',
    padding: '1px 4px',
    width: '100%',
    boxSizing: 'border-box',
  };

  return (
    <input
      type={type === 'int' || type === 'float' ? 'number' : 'text'}
      aria-label={ariaLabel}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => onCommit(coerce())}
      onKeyDown={e => { if (e.key === 'Enter') { onCommit(coerce()); (e.target as HTMLInputElement).blur(); } }}
      style={inputStyle}
    />
  );
}
