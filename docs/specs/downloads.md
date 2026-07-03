# Downloads — Surface Specification

**Status: Planned — not implemented.** This skeleton anchors the surface until its first initiative is grilled and built; the corresponding work is tracked on the issue tracker (Nexus `nxm://` integration and update checks). Feature landscape: [mod-manager feature inventory](../research/mod-manager-feature-inventory.md).

Mod Management context — operates on downloads, archives, and mods; never on records.

## Purpose

Get mods from Nexus into the Loadout with the same "Download with manager" flow MO2 and Vortex own today: receive `nxm://` links from the browser, download via the Nexus API, and hand off to the existing install flow ([mods.md](mods.md) §Install).

## Intended shape (to be confirmed by a grilling session)

- **`nxm://` handler** — the extension registers as OS handler; `nxm://fallout4/mods/4598/files/123456` → enqueue download.
- **Nexus API** — exchange for CDN URL; API key in `vscode.SecretStorage`; handle premium (direct CDN) vs free (redirect) links.
- **Queue UI** — current working spec: status-bar item (`↓ 2 downloading`) opening a quick pick; whether a dedicated tree (MO2's Downloads-tab equivalent) is warranted is an open question.
- **Install hand-off** — completed download → "Install now?" → archive install flow.
- **Update checks** — compare `meta.ini` version against Nexus; `↓ update available` badge on the Mods tree.

## Open questions

- Dedicated Downloads tree vs status-bar + quick pick only?
- Downloads directory: MO2 instance `downloads/` folder (shared with MO2) or Modbench-private?
- Endorsements / mod tracking — in scope for this surface?
- Retention: keep archives after install (MO2 keeps them; enables reinstall) — policy?
