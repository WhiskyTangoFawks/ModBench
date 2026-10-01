import React from 'react';
import type { CellWrite } from './unconfirmedWrites';

const UNCONFIRMED_TOOLTIP = 'Written; waiting for the disk to confirm';

/** A cell's value: the write's until a read covers it, then the disk's, whatever it is. */
export function WrittenValue({ write, disk, children }: Readonly<{
  write: CellWrite | undefined;
  disk: unknown;
  children: (value: unknown) => React.ReactNode;
}>) {
  if (!write) return <>{children(disk)}</>;
  if (!write.marked) return <>{children(write.value)}</>;
  return (
    <span title={UNCONFIRMED_TOOLTIP} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span className="codicon codicon-sync codicon-modifier-spin" aria-hidden />
      {children(write.value)}
    </span>
  );
}
