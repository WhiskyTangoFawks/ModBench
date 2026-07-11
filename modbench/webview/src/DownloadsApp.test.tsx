import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./downloadsVscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { DownloadsApp } from './DownloadsApp';
import { vscode } from './downloadsVscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './downloadsMessages';

function postFromExtension(data: unknown) {
  fireEvent(window, new MessageEvent('message', { data }));
}

beforeEach(() => {
  vi.mocked(vscode.postMessage).mockClear();
});

describe('DownloadsApp — loading state', () => {
  it('shows a loading message before any data arrives', () => {
    render(<DownloadsApp />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('posts READY on mount, so the extension knows the listener is live before it scans', () => {
    render(<DownloadsApp />);
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.READY });
  });
});

describe('DownloadsApp — scan error', () => {
  it('shows the error message from the extension instead of staying on Loading', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ERROR, message: 'downloads/ is not readable' });
    expect(screen.getByText('downloads/ is not readable')).toBeInTheDocument();
  });
});

describe('DownloadsApp — no downloads/ folder', () => {
  it('shows a distinct message when the instance has no downloads folder', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.NO_FOLDER });
    expect(screen.getByText(/instance has no downloads folder/i)).toBeInTheDocument();
  });
});

describe('DownloadsApp — empty downloads/ folder', () => {
  it('shows "no downloads yet" when rows is empty', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows: [] });
    expect(screen.getByText(/no downloads yet/i)).toBeInTheDocument();
  });
});

describe('DownloadsApp — table', () => {
  const rows = [
    { name: 'new.zip', status: 'Downloaded', size: 100, mtimeMs: 200 },
    { name: 'old.zip', status: 'Installed', size: 50, mtimeMs: 100 },
  ];

  it('renders column headers and one row per archive, in the given order', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    for (const header of ['Name', 'Status', 'Size', 'Filetime']) {
      expect(screen.getByText(header)).toBeInTheDocument();
    }
    const cells = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(cells[0]).toContain('new.zip');
    expect(cells[1]).toContain('old.zip');
  });

  it('clicking the Name header re-sorts by name ascending', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.click(screen.getByText('Name'));
    const names = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(names[0]).toContain('new.zip'); // 'new.zip' < 'old.zip' ascending
    expect(names[1]).toContain('old.zip');
  });

  it('clicking the Name header twice re-sorts descending', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.click(screen.getByText('Name'));
    fireEvent.click(screen.getByText('Name'));
    const names = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(names[0]).toContain('old.zip');
    expect(names[1]).toContain('new.zip');
  });
});

describe('DownloadsApp — row selection', () => {
  const rows = [
    { name: 'new.zip', status: 'Downloaded', size: 100, mtimeMs: 200 },
    { name: 'old.zip', status: 'Installed', size: 50, mtimeMs: 100 },
  ];
  // Selection is asserted via aria-selected (the semantic signal), not the
  // inline var() highlight color: happy-dom drops unresolved var() values from
  // toHaveStyle, so a color-var assertion is a false pass. aria-selected
  // genuinely distinguishes selected from unselected rows.
  const rowFor = (text: string) => screen.getByText(text).closest('tr') as HTMLTableRowElement;

  it('clicking a row selects it (aria-selected true)', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    expect(rowFor('new.zip')).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(screen.getByText('new.zip'));
    expect(rowFor('new.zip')).toHaveAttribute('aria-selected', 'true');
  });

  it('is single-row only: selecting another row deselects the first', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.click(screen.getByText('new.zip'));
    fireEvent.click(screen.getByText('old.zip'));
    expect(rowFor('old.zip')).toHaveAttribute('aria-selected', 'true');
    expect(rowFor('new.zip')).toHaveAttribute('aria-selected', 'false');
  });

  it('does not toggle off: clicking an already-selected row keeps it selected', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.click(screen.getByText('new.zip'));
    fireEvent.click(screen.getByText('new.zip'));
    expect(rowFor('new.zip')).toHaveAttribute('aria-selected', 'true');
  });

  it('applies the activeSelectionForeground token on the selected row cells', () => {
    // The foreground token must win over baseCell.color, which is hard-set on
    // every cell — so it lives on the <td>, not the <tr>. Read style.color
    // directly (happy-dom preserves no-space var() on the property, though it
    // drops them from toHaveStyle).
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.click(screen.getByText('new.zip'));
    const selectedCell = screen.getByText('new.zip').closest('td') as HTMLTableCellElement;
    expect(selectedCell.style.color).toContain('activeSelectionForeground');
  });

  it('still opens the row context menu (selection onClick does not swallow onContextMenu)', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.click(screen.getByText('new.zip'));
    fireEvent.contextMenu(screen.getByText('new.zip'));
    expect(screen.getByRole('menuitem', { name: 'Install' })).toBeInTheDocument();
  });
});

describe('DownloadsApp — column alignment', () => {
  const rows = [{ name: 'a-very-long-archive-name.zip', status: 'Downloaded', size: 100, mtimeMs: 200 }];

  const cellFor = (text: string) => screen.getByText(text).closest('td') as HTMLTableCellElement;

  it('right-aligns the Size column in both header and body', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    expect(cellFor('100')).toHaveStyle({ textAlign: 'right' });
    const sizeHeader = screen.getByText('Size').closest('th') as HTMLTableCellElement;
    expect(sizeHeader).toHaveStyle({ textAlign: 'right' });
  });

  it('gives the Name column a wider max-width than Status or Size', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    const px = (el: HTMLElement) => parseInt(el.style.maxWidth, 10);
    const nameW = px(cellFor('a-very-long-archive-name.zip'));
    expect(nameW).toBeGreaterThan(px(cellFor('Downloaded')));
    expect(nameW).toBeGreaterThan(px(cellFor('100')));
  });
});

describe('DownloadsApp — refresh', () => {
  it('clicking Refresh posts a REFRESH message to the extension', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows: [] });
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.REFRESH });
  });
});

describe('DownloadsApp — row context menu', () => {
  const rows = [{ name: 'foo.zip', status: 'Downloaded', size: 100, mtimeMs: 200 }];

  it('right-clicking a row shows an Install menu item', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    expect(screen.getByRole('menuitem', { name: 'Install' })).toBeInTheDocument();
  });

  it('clicking Install posts an INSTALL message with the row name', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Install' }));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.INSTALL, name: 'foo.zip' });
  });

  it('closes the menu after Install is clicked', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Install' }));
    expect(screen.queryByRole('menuitem', { name: 'Install' })).not.toBeInTheDocument();
  });
});

describe('DownloadsApp — theming', () => {
  const rows = [{ name: 'foo.zip', status: 'Downloaded', size: 100, mtimeMs: 200 }];

  it('the row context menu has an opaque, theme-aware background above the table', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    const menu = screen.getByRole('menu');
    expect(menu.style.backgroundColor).not.toBe('');
    expect(menu).toHaveStyle({ zIndex: 1000 });
  });

  it('table cells have a visible border', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    const cell = screen.getAllByRole('cell')[0];
    expect(cell.style.borderStyle).not.toBe('');
    expect(cell.style.borderStyle).not.toBe('none');
  });

  it('hovering a menu item highlights it, and unhovering clears the highlight', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    const item = screen.getByRole('menuitem', { name: 'Install' });
    expect(item.style.background).toBe('');
    fireEvent.mouseEnter(item);
    expect(item.style.background).not.toBe('');
    fireEvent.mouseLeave(item);
    expect(item.style.background).toBe('');
  });
});

describe('DownloadsApp — navigational row actions', () => {
  const openMenu = (row: object) => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows: [row] });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
  };
  const row = (over: object = {}) => ({
    name: 'foo.zip',
    status: 'Downloaded',
    size: 100,
    mtimeMs: 200,
    hasMeta: true,
    modID: '12345',
    ...over,
  });

  it('shows the four navigational actions in the menu', () => {
    openMenu(row());
    for (const name of ['Visit on Nexus', 'Open File', 'Open Meta File', 'Reveal in Explorer']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('Open File / Reveal in Explorer post their message with the row name', () => {
    openMenu(row());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open File' }));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.OPEN_FILE, name: 'foo.zip' });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Explorer' }));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.REVEAL, name: 'foo.zip' });
  });

  it('Visit on Nexus is enabled with a modID and posts VISIT_NEXUS', () => {
    openMenu(row({ modID: '12345' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Visit on Nexus' }));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.VISIT_NEXUS, name: 'foo.zip' });
  });

  it('Visit on Nexus is disabled and inert when the row has no modID', () => {
    openMenu(row({ modID: undefined }));
    const item = screen.getByRole('menuitem', { name: 'Visit on Nexus' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.VISIT_NEXUS }),
    );
  });

  it('Open Meta File is enabled with a sidecar and posts OPEN_META', () => {
    openMenu(row({ hasMeta: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Meta File' }));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.OPEN_META, name: 'foo.zip' });
  });

  it('Open Meta File is disabled and inert when the row has no sidecar', () => {
    openMenu(row({ hasMeta: false }));
    const item = screen.getByRole('menuitem', { name: 'Open Meta File' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.OPEN_META }),
    );
  });
});

describe('DownloadsApp — delete row action', () => {
  const rows = [{ name: 'foo.zip', status: 'Downloaded', size: 100, mtimeMs: 200 }];

  it('right-clicking a row shows a Delete menu item', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('clicking Delete posts a DELETE message with the row name', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.DELETE, name: 'foo.zip' });
  });

  it('closes the menu after Delete is clicked', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });
});

describe('DownloadsApp — hide / unhide row action', () => {
  it('a visible row shows "Hide" and posts HIDE with the row name', () => {
    render(<DownloadsApp />);
    postFromExtension({
      type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED,
      rows: [{ name: 'foo.zip', status: 'Downloaded', size: 100, mtimeMs: 200, hidden: false }],
    });
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    expect(screen.queryByRole('menuitem', { name: 'Unhide' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.HIDE, name: 'foo.zip' });
  });

  it('a hidden row shows "Unhide" and posts UNHIDE with the row name', () => {
    render(<DownloadsApp />);
    // A hidden row is only present in the table when Show hidden is on.
    postFromExtension({
      type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED,
      rows: [{ name: 'foo.zip', status: 'Downloaded', size: 100, mtimeMs: 200, hidden: true }],
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /show hidden/i }));
    fireEvent.contextMenu(screen.getByText('foo.zip'));
    expect(screen.queryByRole('menuitem', { name: 'Hide' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unhide' }));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.UNHIDE, name: 'foo.zip' });
  });
});

describe('DownloadsApp — show hidden toggle', () => {
  const rows = [
    { name: 'visible.zip', status: 'Downloaded', size: 100, mtimeMs: 200, hidden: false },
    { name: 'hidden.zip', status: 'Downloaded', size: 50, mtimeMs: 100, hidden: true },
  ];

  it('is off by default, filtering hidden rows out of the table', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    expect(screen.getByText('visible.zip')).toBeInTheDocument();
    expect(screen.queryByText('hidden.zip')).not.toBeInTheDocument();
  });

  it('reveals hidden rows when checked, rendered dimmed', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.click(screen.getByRole('checkbox', { name: /show hidden/i }));
    const hiddenRow = screen.getByText('hidden.zip').closest('tr');
    expect(hiddenRow).toBeInTheDocument();
    expect(hiddenRow).toHaveStyle({ opacity: '0.5' });
  });

  it('does not dim visible rows when Show hidden is on', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.click(screen.getByRole('checkbox', { name: /show hidden/i }));
    expect(screen.getByText('visible.zip').closest('tr')).toHaveStyle({ opacity: '1' });
  });
});

describe('DownloadsApp — filter box', () => {
  const rows = [
    { name: 'Sleep Or Save.zip', status: 'Downloaded', size: 100, mtimeMs: 200, hidden: false },
    { name: 'other.zip', status: 'Downloaded', size: 50, mtimeMs: 100, hidden: false },
  ];

  it('has a Filter text box in the toolbar', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    expect(screen.getByRole('textbox', { name: /filter/i })).toBeInTheDocument();
  });

  it('narrows the table to rows whose name contains the input, case-insensitively', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    fireEvent.change(screen.getByRole('textbox', { name: /filter/i }), { target: { value: 'sLeEp' } });
    expect(screen.getByText('Sleep Or Save.zip')).toBeInTheDocument();
    expect(screen.queryByText('other.zip')).not.toBeInTheDocument();
  });

  it('restores the full list when the filter is cleared', () => {
    render(<DownloadsApp />);
    postFromExtension({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows });
    const box = screen.getByRole('textbox', { name: /filter/i });
    fireEvent.change(box, { target: { value: 'sleep' } });
    expect(screen.queryByText('other.zip')).not.toBeInTheDocument();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByText('Sleep Or Save.zip')).toBeInTheDocument();
    expect(screen.getByText('other.zip')).toBeInTheDocument();
  });

  it('applies after hidden-filtering: a hidden row whose name matches stays hidden', () => {
    render(<DownloadsApp />);
    postFromExtension({
      type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED,
      rows: [
        { name: 'sleep-visible.zip', status: 'Downloaded', size: 100, mtimeMs: 200, hidden: false },
        { name: 'sleep-hidden.zip', status: 'Downloaded', size: 50, mtimeMs: 100, hidden: true },
      ],
    });
    // Show hidden is off; both names match the query, but the hidden row must
    // still be excluded — hidden-filtering runs before the name-filter.
    fireEvent.change(screen.getByRole('textbox', { name: /filter/i }), { target: { value: 'sleep' } });
    expect(screen.getByText('sleep-visible.zip')).toBeInTheDocument();
    expect(screen.queryByText('sleep-hidden.zip')).not.toBeInTheDocument();
  });
});
