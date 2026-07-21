import React, { useState } from 'react';
import { mono, fg } from './gridStyles';
import { FormKeyPicker } from './FormKeyPicker';
import type { RecordSessionClient } from './RecordSessionClient';

const OBJ_RE = /^(.+?)\s*\[(-?\d+)\]\s*$/;

export interface VmadObjectEditorProps {
  value: unknown;
  client: RecordSessionClient;
  onCommit: (v: { formKey: string; alias: number }) => void;
}

export function VmadObjectEditor({ value, client, onCommit }: Readonly<VmadObjectEditorProps>) {
  const str = typeof value === 'string' ? value : '';
  const m = OBJ_RE.exec(str);
  const diskFk = m ? m[1].trim() : str;
  const diskAlias = m ? Number(m[2]) : -1;

  const [pendingFk, setPendingFk] = useState(diskFk);
  const [alias, setAlias] = useState(diskAlias);
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) { setPrevValue(value); setPendingFk(diskFk); setAlias(diskAlias); }

  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <FormKeyPicker
        client={client}
        validTypes={[]}
        onSelect={fk => { setPicking(false); setPendingFk(fk); onCommit({ formKey: fk, alias }); }}
        onClose={() => setPicking(false)}
      />
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        onClick={() => setPicking(true)}
        style={{
          background: 'var(--vscode-input-background, #3c3c3c)',
          border: '1px solid var(--vscode-input-border, #555)',
          color: pendingFk ? 'var(--vscode-textLink-foreground, #3794ff)' : fg,
          cursor: 'pointer',
          fontFamily: mono,
          fontSize: '12px',
          padding: '1px 4px',
          textAlign: 'left',
        }}
      >
        {pendingFk || <span style={{ opacity: 0.5 }}>— click to pick</span>}
      </button>
      <input
        type="number"
        value={alias}
        onChange={e => setAlias(Number(e.target.value))}
        onBlur={() => onCommit({ formKey: pendingFk, alias })}
        aria-label="Alias"
        style={{ width: 50, fontFamily: mono, fontSize: '12px' }}
      />
    </span>
  );
}
