"""Observes the dotnet commands the code-quality hook runs, through a recording subprocess.run."""
import importlib.util
import pathlib
import subprocess
import unittest
from unittest import mock

HOOK = pathlib.Path(__file__).resolve().parent / "code-quality.py"
SLOT_RUN = HOOK.parents[1] / "skills/validate/slot-run.sh"
spec = importlib.util.spec_from_file_location("code_quality", HOOK)
code_quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(code_quality)


class BuildSlot(unittest.TestCase):
    def test_every_dotnet_command_runs_in_the_build_slot(self):
        with mock.patch.object(code_quality.subprocess, "run") as run:
            code_quality.backend_findings("/repo", ["MEditService/MEditService.Codec/X.cs"])
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual([c[:3] for c in commands], [["bash", str(SLOT_RUN), "dotnet"]] * 2)

    def test_a_slot_that_frees_too_late_gives_no_findings(self):
        late = subprocess.TimeoutExpired("slot-run.sh", 180)
        with mock.patch.object(code_quality.subprocess, "run", side_effect=late):
            self.assertEqual(code_quality.backend_findings("/repo", ["MEditService/MEditService.Codec/X.cs"]), [])


if __name__ == "__main__":
    unittest.main()
