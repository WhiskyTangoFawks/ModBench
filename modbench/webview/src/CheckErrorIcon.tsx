import React from 'react';

export function CheckErrorIcon({ checkError }: { checkError?: string | null }) {
  if (!checkError) return null;
  return (
    <span
      role="img"
      aria-label="warning"
      title={checkError}
      className="codicon codicon-warning"
      style={{
        color: 'var(--vscode-editorWarning-foreground)',
        fontSize: '11px',
        marginLeft: 4,
        cursor: 'default',
      }}
    />
  );
}
