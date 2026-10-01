import React from 'react';
import { toggleBtnStyle } from './gridStyles';

export function ExpandArrow({ expanded, onToggle }: Readonly<{ expanded: boolean; onToggle?: () => void }>) {
  return (
    <button style={toggleBtnStyle} onClick={onToggle} onDoubleClick={e => e.stopPropagation()}>
      {expanded ? '▼' : '▶'}
    </button>
  );
}
