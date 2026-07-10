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
