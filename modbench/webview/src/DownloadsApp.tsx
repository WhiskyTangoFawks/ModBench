import React, { useEffect, useState } from 'react';
import { vscode } from './downloadsVscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './downloadsMessages';
import { sortDownloadRows, type DownloadRow, type DownloadSortColumn } from './downloadsModel';

type State =
  | { kind: 'loading' }
  | { kind: 'noFolder' }
  | { kind: 'rows'; rows: DownloadRow[] }
  | { kind: 'error'; message: string };

const HEADERS: { label: string; column: DownloadSortColumn }[] = [
  { label: 'Name', column: 'name' },
  { label: 'Status', column: 'status' },
  { label: 'Size', column: 'size' },
  { label: 'Filetime', column: 'mtimeMs' },
];

function handleRefresh() {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.REFRESH });
}

interface RowContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly name: string;
  readonly onClose: () => void;
}

/** Row-scoped context menu — the seam future row actions (nav actions,
 *  Delete, Hide/Unhide) each add one more item to. */
function RowContextMenu({ x, y, name, onClose }: RowContextMenuProps) {
  function install() {
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.INSTALL, name });
    onClose();
  }
  return (
    <ul role="menu" style={{ position: 'fixed', top: y, left: x, listStyle: 'none', margin: 0, padding: 4 }}>
      <li
        role="menuitem"
        tabIndex={0}
        style={{ cursor: 'pointer' }}
        onClick={install}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') install();
        }}
      >
        Install
      </li>
    </ul>
  );
}

export function DownloadsApp() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [sort, setSort] = useState<{ column: DownloadSortColumn; descending: boolean }>({
    column: 'mtimeMs',
    descending: true,
  });
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionToWebview;
      if (msg.type === EXTENSION_TO_WEBVIEW.NO_FOLDER) {
        setState({ kind: 'noFolder' });
      } else if (msg.type === EXTENSION_TO_WEBVIEW.ROWS_UPDATED) {
        setState({ kind: 'rows', rows: msg.rows });
      } else if (msg.type === EXTENSION_TO_WEBVIEW.ERROR) {
        setState({ kind: 'error', message: msg.message });
      }
    };
    window.addEventListener('message', handler);
    // Registered before the READY post below, so the extension is guaranteed
    // this listener is live before it reacts and starts posting scan results.
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.READY });
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  if (state.kind === 'loading') return <div>Loading…</div>;
  if (state.kind === 'error') return <div>{state.message}</div>;

  function handleHeaderClick(column: DownloadSortColumn) {
    setSort((prev) =>
      prev.column === column ? { column, descending: !prev.descending } : { column, descending: false },
    );
  }

  return (
    <div>
      <button onClick={handleRefresh}>Refresh</button>
      {state.kind === 'noFolder' && <div>This instance has no downloads folder.</div>}
      {state.kind === 'rows' && state.rows.length === 0 && <div>No downloads yet.</div>}
      {state.kind === 'rows' && state.rows.length > 0 && (
        <table>
          <thead>
            <tr>
              {HEADERS.map(({ label, column }) => (
                <th key={column} onClick={() => handleHeaderClick(column)} style={{ cursor: 'pointer' }}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortDownloadRows(state.rows, sort.column, sort.descending).map((row) => (
              <tr
                key={row.name}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, name: row.name });
                }}
              >
                <td>{row.name}</td>
                <td>{row.status}</td>
                <td>{row.size}</td>
                <td>{new Date(row.mtimeMs).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {menu && <RowContextMenu x={menu.x} y={menu.y} name={menu.name} onClose={() => setMenu(null)} />}
    </div>
  );
}
