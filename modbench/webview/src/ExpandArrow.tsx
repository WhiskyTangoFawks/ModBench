import React from 'react';
import { toggleBtnStyle } from './gridStyles';

export function ExpandArrow({ expanded, onToggle }: Readonly<{ expanded: boolean; onToggle?: () => void }>) {
  return (
    <button style={toggleBtnStyle} aria-expanded={expanded} onClick={onToggle} onDoubleClick={e => e.stopPropagation()}>
      <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} />
    </button>
  );
}
