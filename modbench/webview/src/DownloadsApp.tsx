import React, { useEffect, useState } from 'react';
import { vscode } from './downloadsVscode';
import {
  EXTENSION_TO_WEBVIEW,
  WEBVIEW_TO_EXTENSION,
  type ExtensionToWebview,
} from './downloadsMessages';
import { downloadRowContext, filterHiddenRows, filterRowsByName, sortDownloadRows, type DownloadRow, type DownloadSortColumn } from './downloadsModel';
import { baseCell, headerCell } from './gridStyles';

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

// Per-column width/alignment polish (issue #73), layered on top of the shared
// baseCell/headerCell. Kept Downloads-local rather than pushed into gridStyles.ts,
// which is shared across the mEdit/Mod-Management boundary. Name is the one long
// column (raw archive filenames); Size reads best right-aligned as a number.
// Resizeable columns were assessed and deliberately left out: this is a bare
// <table> with no drag/width-persistence infrastructure, and fixed widths +
// right-aligned Size already make the columns legible.
const COLUMN_STYLE: Record<DownloadSortColumn, React.CSSProperties> = {
  name: { minWidth: '180px', maxWidth: '400px' },
  status: { maxWidth: '100px' },
  size: { maxWidth: '90px', textAlign: 'right' },
  mtimeMs: { maxWidth: '160px' },
};

function handleRefresh() {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.REFRESH });
}

export function DownloadsApp() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [sort, setSort] = useState<{ column: DownloadSortColumn; descending: boolean }>({
    column: 'mtimeMs',
    descending: true,
  });
  const [showHidden, setShowHidden] = useState(false);
  const [filterText, setFilterText] = useState('');
  // Single-row selection (issue #73), keyed on the row's name — transient view
  // state, stable across re-sorts/filters. Multi-select stays deferred to #57.
  const [selectedName, setSelectedName] = useState<string | null>(null);

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
      <label>
        <span>Filter</span>
        <input
          type="text"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(e) => setShowHidden(e.target.checked)}
        />
        <span>Show hidden</span>
      </label>
      {state.kind === 'noFolder' && <div>This instance has no downloads folder.</div>}
      {state.kind === 'rows' && state.rows.length === 0 && <div>No downloads yet.</div>}
      {state.kind === 'rows' && state.rows.length > 0 && (
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {HEADERS.map(({ label, column }) => (
                <th
                  key={column}
                  onClick={() => handleHeaderClick(column)}
                  style={{ ...headerCell, ...COLUMN_STYLE[column], cursor: 'pointer' }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortDownloadRows(
              filterRowsByName(filterHiddenRows(state.rows, showHidden), filterText),
              sort.column,
              sort.descending,
            ).map((row) => {
              const selected = row.name === selectedName;
              // Selected foreground must be applied on the <td> layer: every cell
              // spreads baseCell, which hard-sets `color`, so a `color` on the <tr>
              // would be overridden and the activeSelectionForeground token would be
              // inert. Background stays on the <tr> (cells are transparent).
              const cell = (colStyle: React.CSSProperties) => ({
                ...baseCell,
                ...colStyle,
                ...(selected && { color: 'var(--vscode-list-activeSelectionForeground,#fff)' }),
              });
              return (
                <tr
                  key={row.name}
                  // Hidden rows are only present here under Show hidden; dim them.
                  // Selected row gets the theme-aware list-selection highlight;
                  // selection only moves (no click-to-deselect), so a scalar
                  // selectedName is all the state single-row selection needs.
                  // aria-selected is the semantic signal (also what tests assert on;
                  // happy-dom drops unresolved var() colors from toHaveStyle).
                  aria-selected={selected}
                  style={{
                    opacity: row.hidden ? 0.5 : 1,
                    ...(selected && {
                      backgroundColor: 'var(--vscode-list-activeSelectionBackground,#04395e)',
                    }),
                  }}
                  onClick={() => setSelectedName(row.name)}
                  // Issue #214: right-click a row -> VS Code's own `webview/context` menu
                  // (Install/Visit on Nexus/Open File/Open Meta File/Reveal/Delete/Hide|Unhide),
                  // gated by this attribute instead of a hand-drawn `<ul role="menu">`. No
                  // `onContextMenu`/`preventDefault()` here any more — that's what let the old
                  // hand-drawn menu suppress VS Code's native one.
                  data-vscode-context={downloadRowContext(row)}
                >
                  <td style={cell(COLUMN_STYLE.name)}>{row.name}</td>
                  <td style={cell(COLUMN_STYLE.status)}>{row.status}</td>
                  <td style={cell(COLUMN_STYLE.size)}>{row.size}</td>
                  <td style={cell(COLUMN_STYLE.mtimeMs)}>{new Date(row.mtimeMs).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
