# Failures are data; the front end decides how to surface them

An error-only convention lets a partial result through: a load can succeed while it drops a whole
plugin's records. So a failure is data, and the front end decides how the user sees it.

## Strategic invariants

1. **Never silently wrong** ([principles](../principles.md)). If the UI implies data is present or
   complete and it is not, that is a mandatory user-visible notification, even on an otherwise
   successful operation.
2. **Surfacing is by severity tier; not every error is a popup.** Notification fatigue is
   self-defeating: users learn to dismiss toasts, which re-creates silence, and habitual silence is
   worse.

   | Class | Examples | Surface |
   |---|---|---|
   | Integrity, silent wrong state | a skipped plugin, a partial save, a dropped reindex | notification plus output log, always |
   | An explicit action failed | a command the user invoked errored | notification plus output log |
   | Background, recoverable, high-frequency | a tree fetch failed, a health poll blipped | inline UI plus output log, never a toast |
   | Never | a silent empty catch | banned |

3. **Surfacing goes through an injected reporter**, never raw window calls in business logic. It
   writes the detail to the output channel and shows the surface the severity calls for. That
   keeps VS Code types out of the mEdit client and makes "did this reach the user" unit-testable.
4. **The backend returns structured failure information; the frontend decides how to surface
   it.** A partial outcome is never swallowed and never stringly typed. An endpoint that can
   partially succeed returns a failures collection beside its success.
