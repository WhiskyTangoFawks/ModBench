import React, { useState, useSyncExternalStore } from 'react';
import { mono } from './gridStyles';
import type { FormKeyResolution } from './types';

// Safe default when a caller has no resolution to offer yet (VMAD/pending wiring land in #158/
// #159) — behaves exactly like a genuinely unresolved reference: raw FormKey label, no affordance.
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

// A FormKey rendered as its link affordance. Shared by FormKeyCell (generic fields) and
// VmadSection (VMAD object properties).
//
// Issue #111: the click gesture is split here so it stays uniform across every cell in the
// grid — Ctrl+click follows the reference (xEdit's vstViewClick likewise requires VK_CONTROL),
// which leaves plain click free to mean "edit this cell". Plain click is the caller's to
// define: FormKeyCell opens the picker with it; a read-only cell passes nothing, and plain
// click there does nothing.
//
// The link *affordance* — underline and pointer — appears only while Ctrl is held and the
// pointer is over the cell, and only when the reference resolves (ADR-0031: Unresolved withholds
// it, ResolvedWrongType/ResolvedValidType both grant it, matching xEdit's willingness to follow a
// reference of the wrong type). This mirrors xEdit's vstViewCheckHotTrack, which gates
// hot-tracking on `Allow := Assigned(lLinksTo)`: a link you cannot follow must not look like one.
//
// Issue #157: the button's label is the resolved EditorID when the reference resolves, falling
// back to the raw FormKey string when it doesn't (or when the caller has no resolution to offer
// yet — VMAD/pending wiring land in #158/#159).
export function FormKeyLink({ value, onOpen, onPlainClick, resolution = UNRESOLVED }: Readonly<{
  value: string;
  onOpen: (fk: string) => void;
  onPlainClick?: () => void;
  resolution?: FormKeyResolution;
}>) {
  const ctrl = useCtrlHeld();
  const [hovered, setHovered] = useState(false);
  const linksTo = resolution.state !== 'Unresolved';
  const hot = ctrl && hovered && linksTo;
  const label = resolution.editorId ?? value;

  return (
    <button
      onClick={e => {
        if (e.ctrlKey || e.metaKey) { if (linksTo) onOpen(value); }
        else onPlainClick?.();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'none',
        border: 'none',
        color: 'var(--vscode-textLink-foreground, #3794ff)',
        cursor: hot ? 'pointer' : 'default',
        fontFamily: mono,
        fontSize: '12px',
        padding: 0,
        textDecoration: hot ? 'underline' : 'none',
        textAlign: 'left',
      }}
    >
      {label}
    </button>
  );
}
