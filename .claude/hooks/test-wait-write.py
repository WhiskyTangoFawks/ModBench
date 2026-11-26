#!/usr/bin/env python3
"""PreToolUse[Edit|Write]: refuses a wait on real time in the text an edit writes to a test, as the gate's
check_test_waits.py would."""
import importlib.util
import json
import pathlib
import sys

SCAN = pathlib.Path(__file__).resolve().parents[1] / "skills/validate/check_test_waits.py"
spec = importlib.util.spec_from_file_location("check_test_waits", SCAN)
check_test_waits = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_test_waits)

data = json.load(sys.stdin)
tool_input = data.get("tool_input", {})
text = tool_input.get("new_string") if data.get("tool_name") == "Edit" else tool_input.get("content")
found = check_test_waits.waits(tool_input.get("file_path", ""), text or "")
if found:
    print("A test waits on a value (Waits in MEditService.TestSupport) or on a fake clock, never on real time.",
          file=sys.stderr)
    for wait in found:
        print(f"  line {wait.line}: {wait.text}", file=sys.stderr)
    sys.exit(2)
