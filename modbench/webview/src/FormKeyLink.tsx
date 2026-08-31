import React, { useState, useSyncExternalStore } from 'react';
import { mono } from './gridStyles';
import type { FormKeyResolution } from './types';

// Safe default when a caller has no resolution to offer —
// behaves exactly like a genuinely unresolved reference: raw FormKey label, no affordance.
const UNRESOLVED: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

// Whether Ctrl/Cmd is currently held. Window-level because the affordance has to appear on a
// cell the pointer is already resting over — a cell that will see no fresh mouse event. Every
// link in the grid reads the same store, so the listeners are registered once for all of them
// and torn down when the last link unmounts.
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

// The text a FormKey reads as — "EditorID [FormKey]" when the reference
// resolves, the bare FormKey when it doesn't. Exported because FormKeyCell's Ctrl+C copy path
// must produce exactly what the link displays — a cell must never show one string and hand
// over another.
export function formKeyLabel(value: string, resolution?: FormKeyResolution): string {
  return resolution?.editorId ? `${resolution.editorId} [${value}]` : value;
}

// A FormKey rendered as its link affordance. Shared by FormKeyCell (generic fields) and
// VmadSection (VMAD object properties).
//
// The click gesture is split here so it stays uniform across every cell in the
// grid — Ctrl+click follows the reference (xEdit's vstViewClick likewise requires VK_CONTROL),
// which leaves plain click free to mean "edit this cell". Plain click is the caller's to
// define: FormKeyCell opens the picker with it on a mutable column; on an immutable column
// `onPlainClick` is a no-op, so plain click there does nothing.
//
// The link *affordance* — underline and pointer — appears only while Ctrl is held and the
// pointer is over the cell, and only when the reference resolves (ADR-0031: Unresolved withholds
// it, ResolvedWrongType/ResolvedValidType both grant it, matching xEdit's willingness to follow a
// reference of the wrong type). This mirrors xEdit's vstViewCheckHotTrack, which gates
// hot-tracking on `Allow := Assigned(lLinksTo)`: a link you cannot follow must not look like one.
//
// The button's label is "EditorID [FormKey]" when the reference resolves, falling
// back to the bare FormKey string when it doesn't (or when the caller has no resolution to
// offer). The composite, never the bare EditorID: a
// FormKey is the identity and the EditorID is decoration, so labelling with the decoration alone
// would leave the cell unable to hand the user its own value. It is also the format the picker's
// own items use (`toFormKeyQuickPickItem`), so a reference reads back exactly as it was chosen.
export function FormKeyLink({ value, onOpen, onPlainClick, onDoubleClick, openTrigger, resolution = UNRESOLVED }: Readonly<{
  value: string;
  onOpen: (fk: string) => void;
  onPlainClick?: () => void;
  // ADR-0034: both optional, and both used by exactly one caller — FormKeyCell's
  // mutable branch, which wires them to the same `openPicker` gated the way ScalarCell/FlagCell
  // gate their own mutable open triggers. VmadSection doesn't pass
  // either — no `data-open-trigger` attribute, no double-click behavior.
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
        // ADR-0034: no resting
        // cursor override — the parent DiskCell's `grab` is this cell's resting affordance, since
        // it is a drag source the whole time. `pointer` is asserted only while the reference is
        // hot-tracked, where it is the navigation gesture's own affordance, not a mask.
        cursor: hot ? 'pointer' : undefined,
        fontFamily: mono,
        fontSize: '12px',
        padding: 0,
        textDecoration: hot ? 'underline' : 'none',
        textAlign: 'left',
        // The composite is long, so the link
        // truncates itself. gridStyles' baseCell already ellipsises the <td>, but text-overflow
        // clips at the boundary of an atomic inline box — it never reaches inside a <button>'s
        // own text — so relying on the cell would hard-clip mid-character instead. Truncating
        // rather than shortening keeps the full reference in the DOM, so a selection copies the
        // untruncated text.
        //
        // minWidth: 0 is load-bearing, not tidying: FormKeyCell and VmadSection both wrap this in
        // a `display: inline-flex` span, which makes the button a flex item, and a flex item's
        // default `min-width: auto` refuses to shrink below its content — silently defeating the
        // overflow/ellipsis above and letting a long composite blow the column out instead.
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
