import React from 'react';
import type { RecordDetail } from './types';
import { readOnlyReason } from './recordUtils';

interface PluginHeaderProps {
  override: RecordDetail;
  isImmutable: boolean;
  // #304 / ADR-0035: whether the effective load order actually names this copy — distinct from
  // isImmutable (a vanilla master is immutable and still true here; a shadowed copy is immutable
  // *because* this is false). See recordUtils.ts's readOnlyReason for the derivation this
  // component consumes to word its own tooltip. Dimming itself is *not* this component's job —
  // RecordPanel's own <th> applies DIMMED_OPACITY once, at the header-cell level (#304 review:
  // this component used to also set it on its own root <div> nested inside that <th>, and CSS
  // opacity compounds on nesting — 0.55 twice renders at ~0.30, not the intended 0.55).
  inLoadOrder: boolean;
  // #415 / ADR-0041: whether this plugin's mod folder is tracked. Distinct from the two flags
  // above and checked after them — an immutable plugin's read-only-ness is not something tracking
  // can lift, so its own reason wins (see recordUtils.ts's readOnlyReason).
  isTracked: boolean;
  // #304 / ADR-0036: "origin appears inline in the header only when two loaded copies share a
  // filename" — decided by the caller (RecordPanel, via recordUtils.ts's collidingFilenames over
  // the compare response's own overrides), never recomputed here.
  showOriginInline: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

// #304: the on-screen wording for each read-only reason, plus the tooltip that explains it.
// vanillaMaster keeps the pre-existing plain "(read-only)" label — the familiar, common case gets
// no noisier. notInLoadOrder gets its own distinct label (AC2: visible, not only discoverable on
// hover).
//
// #304 review: the first wording here said "move it earlier in the load order" — wrong axis, not
// just forbidden vocabulary. A shadowed copy is a **file** conflict (Mod Management's Mod
// override order, `modlist.txt`); the Plugin load order (`plugins.txt`) decides which plugin's
// *record* wins, not which physical file a filename resolves to (CONTEXT-MAP.md, CONTEXT.md:37-49
// — "load order" bare is the exact ambiguity both call out). Following the old advice would do
// nothing.
//
// It is also not the only cause: `GameSession.AddUnlistedPlugin`/`SessionManager.
// LoadUnlistedPlugin` (MEditService.Core/Session/) open a copy the effective load order doesn't
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
// #415 / ADR-0041: `untracked` joins them, and vanillaMaster's tooltip gains the sentence it was
// always missing — the way out. AC4 asks for two different signposts because there are two
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
  // The friction here is deliberate (ADR-0041): editing someone else's plugin in place is the
  // community's own anti-pattern, so tracking is a decision the user makes rather than something
  // that happens to them. Which is exactly why the label has to say the friction is one command
  // deep — a read-only column with no stated way out reads as a defect, not as a choice.
  untracked: {
    label: '(untracked)',
    title:
      'This plugin\u2019s mod is not tracked, so its records are read-only. '
      + 'Run \u201cModbench: Track Mod\u201d on it once to start editing \u2014 '
      + 'its records become text in the mod\u2019s own git repository, and your edits show up in Source Control.',
  },
};

// Issue #209: this used to also own "Add Master…" (a button + its own hand-drawn candidate
// dropdown, gated on isHeaderRecord/showMasterPicker/loadedPlugins) — deleted, not adapted, along
// with the rest of the column-header's hand-drawn chrome (ColumnHeaderMenu, PluginTargetPicker),
// in favor of the column header's native right-click menu (ADR-0033: no standalone control once
// an action is right-click-reachable, same rule #207 applied to the inline revert button).
// #335/ADR-0038: that native menu entry is gone too now — nothing may declare a master directly
// any more; the header record's masters field still renders through the ordinary compare-grid
// rows below, read-only.
export function PluginHeader({
  override: o, isImmutable, inLoadOrder, isTracked, showOriginInline, collapsed, onToggleCollapse,
}: PluginHeaderProps) {
  const reason = readOnlyReason(isImmutable, inLoadOrder, isTracked);
  return (
    <div>
      {/* Issue #3: left-click the plugin-name chip collapses/expands this column. ADR-0036:
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
        </>
      )}
    </div>
  );
}
