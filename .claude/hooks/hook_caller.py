"""Claude Code puts agent_id in a hook's payload only for a subagent's call. A subagent's
transcript_path is its parent's, so the path does not tell the two apart."""


def is_subagent(payload):
    return bool(payload.get("agent_id"))
