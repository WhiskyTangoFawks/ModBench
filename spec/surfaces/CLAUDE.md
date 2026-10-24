# Surfaces

A surface states behaviour a user can observe. It is the source of truth for what the user sees, not a technical specification. A sentence belongs here only when a user would notice if it were different. Anything else is a mechanism.

- Write each line as a user story, in the surface where the user meets the behaviour.
- A behaviour offered on several surfaces has one home. The other surfaces point to it.
- A behaviour no user starts, such as a sync or a background check, lives in the surface that shows its result.
- An exception to a principle is named as one, in the story it qualifies.

Code and tickets cite stories by number. Append a new story to the end of its list, so every existing citation still points at the same story.
