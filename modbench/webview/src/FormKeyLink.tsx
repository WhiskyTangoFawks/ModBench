import React, { useState, useSyncExternalStore } from 'react';
import { mono } from './gridStyles';
import type { FormKeyResolution } from './types';

// Safe default when a caller has no resolution to offer —
// behaves exactly like a genuinely unresolved reference: raw FormKey label, no affordance.
const UNRESOLVED: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

// Window-level because the affordance has to appear on a cell the pointer already rests over — a
// cell that will see no fresh mouse event. Every link reads this one store, so the listeners are
// registered once.
let ctrlHeld = false;
const subscribers = new Set<() => void>();

function onKeyDown(e: KeyboardEvent) { if (e.ctrlKey || e.metaKey) setCtrlHeld(true); }
function onKeyUp(e: KeyboardEvent) { if (!e.ctrlKey && !e.metaKey) setCtrlHeld(false); }
// Focus can leave mid-chord (Alt+Tab), stranding the affordance on with no keyup to clear it.
function onBlur() { setCtrlHeld(false); }

function setCtrlHeld(held: boolean) {
  if (held === ctrlHeld) return;
  ctrlHeld = held;
  for (const notify of subscribers) notify();
}

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange);
  if (subscribers.size === 1) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
  }
  return () => {
    subscribers.delete(onStoreChange);
    if (subscribers.size === 0) {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      // Nothing is listening for the keyup that would clear it, so don't leave it latched on.
      ctrlHeld = false;
    }
  };
}

const getCtrlHeld = () => ctrlHeld;

// useSyncExternalStore is React's own answer to "component state mirrors a mutable value that
// lives outside React": it subscribes and reads the snapshot without a setState in an effect,
// which would cascade renders across every link in the grid.
function useCtrlHeld(): boolean {
  return useSyncExternalStore(subscribe, getCtrlHeld, getCtrlHeld);
}

// "EditorID [FormKey]" when the reference resolves, the bare FormKey when it doesn't. Exported so
// the Ctrl+C copy path produces exactly what the link displays — a cell must never show one
// string and hand over another.
export function formKeyLabel(value: string, resolution?: FormKeyResolution): string {
  return resolution?.editorId ? `${resolution.editorId} [${value}]` : value;
}

// Ctrl+click follows the reference (xEdit's vstViewClick likewise requires VK_CONTROL), which
// leaves plain click free to mean "edit this cell"; plain click is the caller's to define.

// The underline-and-pointer affordance appears only while Ctrl is held over a resolvable
// reference (ADR-0005), mirroring xEdit's vstViewCheckHotTrack: a link you cannot follow must not
// look like one.

// The label is the composite, never the bare EditorID: a FormKey is the identity and the EditorID
// is decoration, and it is the format the picker's own items use, so a reference reads back as it
// was chosen.
export function FormKeyLink({ value, onOpen, onPlainClick, onDoubleClick, openTrigger, resolution = UNRESOLVED }: Readonly<{
  value: string;
  onOpen: (fk: string) => void;
  onPlainClick?: () => void;
  // ADR-0018: both optional — a caller with no mutable open gesture omits them.
  onDoubleClick?: () => void;
  openTrigger?: boolean;
  resolution?: FormKeyResolution;
}>) {
  const ctrl = useCtrlHeld();
  const [hovered, setHovered] = useState(false);
  const linksTo = resolution.state !== 'Unresolved';
  const hot = ctrl && hovered && linksTo;
  const label = formKeyLabel(value, resolution);

  return (
    <button
      data-open-trigger={openTrigger || undefined}
      onClick={e => {
        if (e.ctrlKey || e.metaKey) { if (linksTo) onOpen(value); }
        else onPlainClick?.();
      }}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'none',
        border: 'none',
        color: 'var(--vscode-textLink-foreground, #3794ff)',
        // ADR-0018: no resting cursor override — the parent DiskCell's `grab` is this cell's
        // resting affordance, since it is a drag source the whole time. `pointer` is asserted only
        // while the reference is hot-tracked.
        cursor: hot ? 'pointer' : undefined,
        fontFamily: mono,
        fontSize: '12px',
        padding: 0,
        textDecoration: hot ? 'underline' : 'none',
        textAlign: 'left',
        // gridStyles' baseCell already ellipsises the <td>, but text-overflow clips at the
        // boundary of an atomic inline box and never reaches inside a <button>'s own text, so
        // relying on the cell alone would hard-clip mid-character.

        // `minWidth: 0` is load-bearing: this button is a flex item, and a flex item's default
        // `min-width: auto` refuses to shrink below its content, defeating the ellipsis above.
        display: 'inline-block',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        verticalAlign: 'bottom',
      }}
    >
      {label}
    </button>
  );
}
