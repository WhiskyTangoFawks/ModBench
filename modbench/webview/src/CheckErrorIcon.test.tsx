import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { CheckErrorIcon } from './CheckErrorIcon';

describe('CheckErrorIcon', () => {
  it('renders nothing when checkError is null or undefined', () => {
    const { container: a } = render(<CheckErrorIcon checkError={null} />);
    expect(a.textContent).toBe('');
    const { container: b } = render(<CheckErrorIcon checkError={undefined} />);
    expect(b.textContent).toBe('');
  });

  it('renders a warning icon with the message as its title', () => {
    render(<CheckErrorIcon checkError="[FFFFFF:Dangling.esm] <Error: Could not be resolved>" />);
    const icon = screen.getByRole('img', { name: 'warning' });
    expect(icon).toHaveAttribute('title', '[FFFFFF:Dangling.esm] <Error: Could not be resolved>');
    expect(icon).toHaveClass('codicon', 'codicon-warning');
    expect(icon.getAttribute('style')).toContain('var(--vscode-editorWarning-foreground)');
  });
});
