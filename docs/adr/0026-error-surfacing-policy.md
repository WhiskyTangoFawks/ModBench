---
status: accepted
---

# Errors and silent-wrong-state are surfaced to the user on a severity tier, never swallowed

The trigger was a load that returned HTTP 200 while silently dropping a whole plugin's records (a plugin Mutagen couldn't parse). Nothing "failed", so an error-only convention would have let it through — yet the user's mental model of *what is loaded* was wrong. The governing principle is therefore not "surface errors" but:

> **The user's mental model must never be silently wrong.** If the UI implies data is present or complete and it is not, that is a mandatory, user-visible notification — even on an otherwise successful operation.

A blanket "every error is a popup" rule is rejected: notification fatigue is self-defeating — users learn to dismiss toasts, which re-creates silence, worse because it is now habitual. Conditions are surfaced on a **severity tier** by user impact:

| Class | Examples | Surface |
|---|---|---|
| **Integrity / silent-wrong-state** | skipped plugin (records missing), partial save, dropped/failed reindex | **Notification (warning or error) + output log** — always |
| **Explicit action failed** | a command the user invoked errored | **Notification (error) + output log** |
| **Background / recoverable / high-frequency** | a tree fetch failed, a health poll blipped | **Inline UI + output log** (error tree node, status bar) — *not* a toast |
| **Never** | silent `catch {}` | banned |

Surfacing goes through an **injected reporter**, not raw `vscode.window.*` calls in business logic: a `report(severity, userMessage, detail)`-style dependency that writes `detail` to the `mEdit` output channel and shows the surface appropriate to `severity`. This keeps `vscode` types out of `SessionController`/repositories (per `modbench/CLAUDE.md`) and makes "did this reach the user?" unit-testable — as the `SessionWizard` skipped-plugin tests already demonstrate.

The backend half: **endpoints return structured failure information; the frontend decides how to surface it.** The backend never swallows a partial outcome and never relies on stringly-typed error text for the UI. `SessionLoadResponse.Failures` (the `load-explicit` resilient-load work) is the reference pattern.

## Consequences

- `modbench/CLAUDE.md` gains an "Error surfacing" rule extending the existing "no silent `catch`" logging rule with the severity tiers and the injected-reporter requirement.
- New frontend code uses the injected reporter; existing `showError`/`showWarning` call sites migrate opportunistically (no big-bang refactor).
- Backend endpoints that can partially succeed return a structured failures collection (named record) alongside success, rather than logging-and-forgetting or failing the whole call.
- Adopted incrementally: this ADR is the policy; a shared reporter utility is introduced when the next surfacing need lands rather than retrofitted all at once.
