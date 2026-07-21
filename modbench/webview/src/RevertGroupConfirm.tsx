import React from 'react';
import { ModalShell } from './ModalShell';
import type { PendingChange } from './types';

// Issue #139: a multi-member group revert takes every linked edit with it (ADR-0028), so the
// user confirms first, seeing the members that travel with it — rather than the panel firing the
// 409 the backend returns for a partial group revert. A group of one skips this entirely.
export function RevertGroupConfirm({ members, onConfirm, onCancel }: Readonly<{
  members: PendingChange[];
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  return (
    <ModalShell title="Revert this group? All linked edits are reverted together." confirmLabel="Revert"
      onConfirm={onConfirm} onCancel={onCancel}>
      <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: '11px', maxHeight: 200, overflowY: 'auto' }}>
        {members.map(m => (
          <li key={m.id}>{`${m.recordType ?? ''} / ${m.formKey ?? ''} · ${m.fieldPath ?? ''}`}</li>
        ))}
      </ul>
    </ModalShell>
  );
}
