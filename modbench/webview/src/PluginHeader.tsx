import React from 'react';
import type { RecordDetail } from './types';
import { readOnlyReason } from './recordUtils';

interface PluginHeaderProps {
  override: RecordDetail;
  isImmutable: boolean;
  // ADR-0035: whether the effective load order actually names this copy — distinct from
  // isImmutable (a vanilla master is immutable and still true here; a shadowed copy is immutable
  // *because* this is false). See recordUtils.ts's readOnlyReason for the derivation this
  // component consumes to word its own tooltip. Dimming itself is *not* this component's job —
  // RecordPanel's own <th> applies DIMMED_OPACITY once, at the header-cell level; setting it
  // again on a nested element would compound (CSS opacity multiplies on nesting — 0.55 twice
  // renders at ~0.30, not the intended 0.55).
  inLoadOrder: boolean;
  // ADR-0041: whether this plugin's mod folder is tracked. Distinct from the two flags
  // above and checked after them — an immutable plugin's read-only-ness is not something tracking
  // can lift, so its own reason wins (see recordUtils.ts's readOnlyReason).
  isTracked: boolean;
  // ADR-0036: "origin appears inline in the header only when two loaded copies share a
  // filename" — decided by the caller (RecordPanel, via recordUtils.ts's collidingFilenames over
  // the compare response's own overrides), never recomputed here.
  showOriginInline: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  // The already-combined `data-vscode-context` JSON string (recordUtils.ts's
  // headerCellContext + combineVscodeContexts) VS Code's own `contributes.menus["webview/context"]`
  // gates Copy as Override Into…/Copy as New Record Into… on — same shape as DiskCell's own
  // `vscodeContext` prop, computed by the caller (RecordPanel) rather than derived in here.
  vscodeContext?: string;
  // Dispatches the sanctioned is_partial_form write (EDIT_FIELD, via RecordPanel's own
  // handleEditCell) — never called directly from here, since the record editor has exactly one
  // write path (ADR-0041) and this component's job is only to render the state and report the
  // gesture. Absent entirely from RecordPanel.editableColumns' own writability gate (that gate
  // deliberately excludes a Partial Form column's *body* fields — o.isPartialForm's own doc
  // comment — but the header write is what clears the flag in the first place, so it cannot be
  // gated on the very state it exists to change).
  onTogglePartialForm: (next: boolean) => void;
}

// The on-screen wording for each read-only reason, plus the tooltip that explains it.
// vanillaMaster keeps the plain "(read-only)" label — the familiar, common case gets
// no noisier. notInLoadOrder gets its own distinct label (visible, not only discoverable on
// hover).
//
// The tooltip must not advise "move it earlier in the load order" — wrong axis, not
// just forbidden vocabulary. A shadowed copy is a **file** conflict (Mod Management's Mod
// override order, `modlist.txt`); the Plugin load order (`plugins.txt`) decides which plugin's
// *record* wins, not which physical file a filename resolves to (CONTEXT-MAP.md, CONTEXT.md:37-49
// — "load order" bare is the exact ambiguity both call out). That advice would do
// nothing.
//
// Shadowing is also not the only cause: `LoadOrder.Open`/`LoadOrderMirror.
// LoadUnlistedPlugin` (MEditService.Core/Load order/) open a copy the effective load order doesn't
// name for either of two reasons the frontend can't currently tell apart — a copy shadowed by a
// higher-priority mod, *or* a plugin file `plugins.txt` never lists at all (an enabled mod's own
// optional/extra .esp). `LoadUnlistedPlugin`'s own comment and `modmanager/unlistedPlugins.ts`'s
// `findUnlistedPlugins` both treat these as one case by design ("neither needs to be
// distinguished... both are equally 'not loaded'") — `PluginResponse` carries no signal telling
// them apart, so a column marked `!inLoadOrder` may be either. The wording below is therefore true
// for both: it states the fact (this copy is not what the game loads) and names *where* that's
// decided — the Mods view (file conflicts) and the Plugins view (whether a plugin is listed at
// all) — without prescribing a single gesture that would only fix one of the two causes. "Mods"/
// "Plugins" here are the actual, capitalized view titles (`package.json`'s `modbench.modList`/
// `modbench.pluginListTree` — `docs/specs/mods.md`/`plugins.md`), named as navigable surfaces, not
// imported Mod Management vocabulary — CONTEXT-MAP.md's boundary forbids the word "mod" as a
// common noun and "priority" as a mechanism, not the proper name of a surface the user can go to.
//
// ADR-0041: `untracked` and `vanillaMaster` carry two different signposts because there are two
// different answers: a plugin in a mod folder is one Track away from editable, while a base-game
// master can never be tracked at all and its blessed path is a patch plugin instead. Neither
// message names the other's way out; that is asserted, not left to review.
const READ_ONLY_TEXT: Record<'vanillaMaster' | 'notInLoadOrder' | 'untracked', { label: string; title: string }> = {
  vanillaMaster: {
    label: '(read-only)',
    title:
      'This is a vanilla, DLC, or Creation Club master and can never be edited. '
      + 'To change what it defines, author a patch plugin holding the override and edit that.',
  },
  notInLoadOrder: {
    label: '(not loaded)',
    title:
      'This copy plays no part in what the game actually loads, so editing it here changes '
      + 'nothing anywhere. Whether this file loads, and which copy, is decided in the Mods and '
      + 'Plugins views.',
  },
  // The command is quoted exactly as the palette shows it — package.json's title ("Track\u2026")
  // under its category ("Modbench"). PluginHeader.test.tsx asserts that exact string, so a rename
  // of the command breaks the test rather than silently breaking the signpost.
  //
  // The friction here is deliberate (ADR-0041): editing someone else's plugin in place is the
  // community's own anti-pattern, so tracking is a decision the user makes rather than something
  // that happens to them. Which is exactly why the label has to say the friction is one command
  // deep — a read-only column with no stated way out reads as a defect, not as a choice.
  untracked: {
    label: '(untracked)',
    title:
      'This plugin\u2019s mod is not tracked, so its records are read-only. '
      + 'Run \u201cModbench: Track\u2026\u201d on it once to start editing \u2014 '
      + 'its records become text in the mod\u2019s own git repository, and your edits show up in Source Control.',
  },
};

// ADR-0038: nothing may declare a master directly —
// the header record's masters field renders through the ordinary compare-grid
// rows below, read-only.
// CONTEXT.md's own Partial Form glossary entry, quoted for the checkbox's tooltip — the
// record editor's own vocabulary for what the flag means, not a paraphrase that could drift from
// it.
const PARTIAL_FORM_TITLE =
  'Partial Form: marks an override that exists only to carry children. Its own fields are ignored '
  + 'for conflict resolution and read-only here except this checkbox — clear it to make the '
  + 'record’s own fields editable again.';

export function PluginHeader({
  override: o, isImmutable, inLoadOrder, isTracked, showOriginInline, collapsed, onToggleCollapse,
  vscodeContext, onTogglePartialForm,
}: PluginHeaderProps) {
  const reason = readOnlyReason(isImmutable, inLoadOrder, isTracked);
  // The same three facts that decide every other field's writability on this column — an
  // immutable, not-in-load-order or untracked column offers no affordance that could ever land, so
  // the checkbox is disabled (never hidden — the current state must stay visible) rather than a
  // silent dead control (no-silent-dead-UI).
  const canWrite = !isImmutable && inLoadOrder && isTracked;
  return (
    <div data-vscode-context={vscodeContext}>
      {/* Left-click the plugin-name chip collapses/expands this column. ADR-0036:
          origin is never what the user reads by default — always in the tooltip, inline in the
          label only when a second loaded copy shares this filename (showOriginInline). */}
      <div
        onClick={onToggleCollapse}
        style={{ cursor: 'pointer' }}
        title={`Origin: ${o.origin}`}
      >
        {showOriginInline ? `${o.plugin} (${o.origin})` : o.plugin}
      </div>
      {!collapsed && (
        <>
          <div style={{ fontWeight: 400, opacity: 0.6, fontSize: '11px' }}>
            [{o.loadOrderIndex}]{o.isWinner ? ' ✓ winner' : ''}
          </div>
          {reason && (
            <div
              style={{ marginTop: 3, fontSize: '10px', opacity: 0.55, fontStyle: 'italic' }}
              title={READ_ONLY_TEXT[reason].title}
            >
              {READ_ONLY_TEXT[reason].label}
            </div>
          )}
          {o.isPartialFormable && (
            <label
              style={{ display: 'block', marginTop: 3, fontSize: '10px', opacity: 0.85 }}
              title={PARTIAL_FORM_TITLE}
            >
              <input
                type="checkbox"
                checked={o.isPartialForm}
                disabled={!canWrite}
                onChange={e => onTogglePartialForm(e.target.checked)}
              />
              {' '}Partial Form
            </label>
          )}
        </>
      )}
    </div>
  );
}
