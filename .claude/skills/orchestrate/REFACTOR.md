# Refactor brief

Your goal is the branch's diff against `main`, refactored to the repo's coding standards. The executor made it work. You make it clean: simple, elegant code that follows `docs/principles.md`. Each fix leaves less to maintain. Work in the branch's worktree with absolute paths. Every command runs in the worktree.

The standards are `CODING_STANDARDS.md`, the files it names, and the smell baseline in step 3 of `~/.claude/skills/code-review/SKILL.md`. Skip anything a gate holds.

Apply every rule to every code and test hunk of `git diff main...HEAD`. The ticket after this brief says what the code is for. A break the fillings name is the executor's decision, so leave it as built.

Fix each breach of a documented standard. Fix a smell when the fix leaves the code simpler. Decline every item you leave, with its reason, in the report.

The tests are the oracle. Each refactor commit changes production code alone or tests alone. The tests a production commit leaves alone prove its behaviour. A fix that would change behaviour is a finding, and so is a bug you see.

Your scope is those hunks and the code their fixes need, inside your lane's boxes. A concept that needs a new name, or a fix that needs a suppression, goes in the report as a description. Never name it or add it.

Run `/validate` when the work stands. Review is the orchestrator's, dispatched after you report. A conflict from merging `main`, or a red gate outside your lane's boxes, is a finding.

Your turn is your life. The final message of your turn is your report, and nothing you were waiting for arrives after it. Every wait is a foreground call: Bash with `run_in_background: false` and `timeout: 600000`. Work that outlasts one call is detached and polled with further foreground calls, which is how `/validate` runs the gates.

Done means committed. Gates are green, the SHA is reported, and `git status` is clean. A diff that needs no change is done with no commit.

Report, under 400 words:

1. The gates' verdict line, quoted.
2. Each commit: the SHA and the rules it applies.
3. Each declined item: file, line, the rule and the reason.
4. Findings: bugs, fixes that would change behaviour, and naming questions.
5. Test counts as passed before, passed after, and delta, with skipped stated separately. Name each test you retired, with the test that now holds its case.

Fix a blocking finding that comes back from review the same way, and name the new commit in the report.
