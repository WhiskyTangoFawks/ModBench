# Downloads — Surface Specification

**Status: Planned — not implemented.** This skeleton anchors the surface until its first initiative is grilled and built; the corresponding work is tracked on the issue tracker (Nexus `nxm://` integration and update checks). Feature landscape: [mod-manager feature inventory](../research/mod-manager-feature-inventory.md).

Mod Management context — operates on downloads, archives, and mods; never on records.

Placement: [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md) — an editor-tab webview (the same mechanism as the mEdit Record Editor panel), not a sidebar tree. Downloads is occasional/rich rather than something referenced mid-navigation, so it doesn't compete for the permanent sidebar slots Mods and Plugins occupy, and it gets full editor width for the meta-info columns below.

## Purpose

Get mods from Nexus into the Loadout with the same "Download with manager" flow MO2 and Vortex own today: receive `nxm://` links from the browser, download via the Nexus API, and hand off to the existing install flow ([mods.md](mods.md) §Install).

## Intended shape (to be confirmed by a grilling session)

- **`nxm://` handler** — the extension registers as OS handler; `nxm://fallout4/mods/4598/files/123456` → enqueue download.
- **Nexus API** — exchange for CDN URL; API key in `vscode.SecretStorage`; handle premium (direct CDN) vs free (redirect) links.
- **Queue UI** — an editor-tab webview (opened via a command, same pattern as `modbench.openEditor`) listing filename, install state, and file info, with right-click install/reinstall/delete/hide and batch variants of each, plus a hash-based "Query Info" lookup against Nexus. A status-bar item (`↓ 2 downloading`) gives the ambient glance and opens the tab on click — resolved per ADR-0027; a bottom-panel tree (Ports-panel style) was considered and is the fallback if the tab approach doesn't scale.
- **Install hand-off** — completed download → "Install now?" → archive install flow.
- **Update checks** — compare `meta.ini` version against Nexus; `↓ update available` badge on the Mods tree.

## Open questions

- Downloads directory: MO2 instance `downloads/` folder (shared with MO2) or Modbench-private?
- Endorsements / mod tracking — in scope for this surface?
- Retention: keep archives after install (MO2 keeps them; enables reinstall) — policy?
