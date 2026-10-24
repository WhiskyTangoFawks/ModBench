import { describe, it, expect, vi } from 'vitest';
import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ ThemeIcon, TreeItem, TreeItemCollapsibleState }));

import { ErrorNode } from '../errorNode';

describe('the error row in place of a list whose first read failed', () => {
  it('shows the error icon and "Failed to load:" with the reason, and the reason again in its tooltip', () => {
    const row = new ErrorNode('ENOENT: no such file');
    expect({ label: row.label, tooltip: row.tooltip, icon: row.iconPath }).toEqual({
      label: 'Failed to load: ENOENT: no such file',
      tooltip: 'ENOENT: no such file',
      icon: new ThemeIcon('error'),
    });
  });
});
