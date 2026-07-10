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

export function DownloadsApp() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [sort, setSort] = useState<{ column: DownloadSortColumn; descending: boolean }>({
    column: 'mtimeMs',
    descending: true,
  });

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
              <tr key={row.name}>
                <td>{row.name}</td>
                <td>{row.status}</td>
                <td>{row.size}</td>
                <td>{new Date(row.mtimeMs).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
