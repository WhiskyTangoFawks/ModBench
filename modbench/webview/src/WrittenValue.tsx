import React, { useEffect } from 'react';
import type { CellWrite, CellWrites } from './unconfirmedWrites';

const UNCONFIRMED_TOOLTIP = 'Written; waiting for the disk to confirm';

// VS Code's `$(sync~spin)`: the codicon's own glyph, turning as the `~spin` modifier turns it.
function SyncSpin() {
  return (
    <svg width="12" height="12" viewBox="0 0 300 300" fill="currentColor" aria-hidden style={{ flex: 'none' }}>
      <g transform="matrix(1 0 0 -1 0 300)">
        <path d="M263 234V178Q263 174 260 171.5Q257 169 253 169H197Q193 169 190 171.5Q187 174 187 178Q187 182 190 185Q193 188 197 188H236Q225 213 201.5 228.5Q178 244 150 244Q119 244 93.5 225Q68 206 60 176Q59 172 56.5 170.5Q54 169 51 169H48Q44 170 42.5 173.5Q41 177 42 181Q52 217 82 240Q112 263 150 263Q179 262 203.5 249Q228 236 244 212V234Q244 238 246.5 241Q249 244 253 244Q257 244 260 241Q263 238 263 234ZM252 131Q248 132 244.5 130Q241 128 240 124Q231 94 206 75Q181 56 150 56Q122 56 98.5 71.5Q75 87 64 112H103Q107 112 109.5 115Q112 118 112 122Q112 126 109.5 128.5Q107 131 103 131H47Q43 131 40 128.5Q37 126 37 122V65Q37 62 40 59Q43 56 47 56Q51 56 53.5 59Q56 62 56 65V88Q71 64 96 50.5Q121 37 150 37Q187 37 217.5 60Q248 83 258 119Q259 123 257 126.5Q255 130 251 131Z" />
      </g>
      <animateTransform attributeName="transform" type="rotate" from="0 150 150" to="360 150 150" dur="1.5s" repeatCount="indefinite" />
    </svg>
  );
}

/** A cell's value: the write's until a read covers it, then the disk's, whatever it is. */
export function WrittenValue({ write, disk, name, text, settle, children }: Readonly<{
  write: CellWrite | undefined;
  disk: unknown;
  /** The cell, as the Output line names it. */
  name: string;
  /** What the cell shows for a value. */
  text: (value: unknown) => string;
  settle: CellWrites['settle'];
  children: (value: unknown) => React.ReactNode;
}>) {
  const covered = write?.covered === true;
  const line = write && covered && text(write.value) !== text(disk)
    ? `${name} was written "${text(write.value)}", and the disk now shows "${text(disk)}".`
    : undefined;
  const cell = write?.cell;
  useEffect(() => {
    if (covered && cell !== undefined) settle(cell, line);
  }, [covered, cell, line, settle]);

  if (!write || covered) return <>{children(disk)}</>;
  if (!write.marked) return <>{children(write.value)}</>;
  return (
    <span title={UNCONFIRMED_TOOLTIP} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <SyncSpin />
      {children(write.value)}
    </span>
  );
}
