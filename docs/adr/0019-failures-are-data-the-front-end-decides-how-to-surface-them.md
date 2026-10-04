# Failures are data; the front end decides how to surface them

An error-only convention lets a partial result through: a load can succeed while it drops a whole plugin's records. So a failure is data, and the front end decides how the user sees it.

## Consequences

- Not every failure is a popup. A toast the user learns to dismiss recreates silence. A failure that leaves the user's picture wrong, or an action the user asked for that failed, notifies. A background failure that recovers on its own shows inline and never toasts. Every failure reaches the Output.
