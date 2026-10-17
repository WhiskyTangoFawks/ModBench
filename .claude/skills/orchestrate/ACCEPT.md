# Acceptance brief

Your goal is the epic's spec stories, each driven end to end through the acceptance harness. Read `.claude/skills/acceptance/SKILL.md` first and follow it. Every command runs in the worktree, on the final `main`.

Read each story where it lives in the spec. Choose the dev instance for the case: the game that shows it, or a folder you shape. Shape it as the skill says, and list every shaping step.

Verified means observed. A story passes on a call's result or a file's content, quoted. A claim without a quote is unverified.

Report each story as one of:

- **passed**, with the quoted evidence.
- **failed**, with the quoted evidence and the spec line it breaks.
- **out of reach**, with the skill's reason: a picker, prompt, confirmation, menu, key, what a tree row draws, or MO2 itself.

Fix nothing. A failure is the orchestrator's to route.

Your turn is your life. Every wait is a foreground call, and `accept.sh down` is your last command. The final message is your report.
