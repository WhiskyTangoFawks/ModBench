import React from 'react';

export function CheckErrorIcon({ checkError }: { checkError?: string | null }) {
  if (!checkError) return null;
  return (
    <span
      title={checkError}
      style={{
        color: 'var(--vscode-errorForeground, #f88)',
        fontSize: '11px',
        marginLeft: 4,
        cursor: 'default',
      }}
    >⚠</span>
  );
}
