"""Pins select_gates.py: each changed path selects the gates it can break, and names itself as the
reason."""
import contextlib
import io
import unittest

import select_gates


def selected(*changed):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        select_gates.main(io.StringIO(''.join(f'{path}\n' for path in changed)))
    return out.getvalue().splitlines()


class SelectGates(unittest.TestCase):
    def test_backend_source_selects_backend_api_drift_and_the_scripts_it_answers(self):
        self.assertEqual(selected('MEditService/MEditService.Http/Program.cs'), [
            '--backend MEditService/MEditService.Http/Program.cs',
            '--api-drift MEditService/MEditService.Http/Program.cs',
            '--scripts MEditService/MEditService.Http/Program.cs',
        ])

    def test_scripts_and_the_fixture_instance_their_harness_loads_select_scripts(self):
        self.assertEqual(selected('scripts/medit.py'), ['--scripts scripts/medit.py'])
        self.assertEqual(selected('DevListFallout/profiles/Dev/plugins.txt'), ['--scripts DevListFallout/profiles/Dev/plugins.txt'])

    def test_another_fixture_instance_selects_nothing(self):
        self.assertEqual(selected('DevListSkyrim/profiles/Dev/plugins.txt'), [])

    def test_frontend_source_selects_frontend(self):
        self.assertEqual(selected('modbench/src/extension.ts'), ['--frontend modbench/src/extension.ts'])

    def test_docs_and_spec_select_docs(self):
        self.assertEqual(selected('spec/architecture/target-architecture.d2'),
                         ['--docs spec/architecture/target-architecture.d2'])
        self.assertEqual(selected('spec/GLOSSARY.md'), ['--docs spec/GLOSSARY.md'])

    def test_markdown_outside_docs_and_spec_selects_nothing(self):
        self.assertEqual(selected('MEditService/CLAUDE.md', 'modbench/CLAUDE.md', 'README.md'), [])

    def test_tooling_selects_nothing(self):
        self.assertEqual(selected('.claude/skills/validate/run-gates.sh', '.vale.ini'), [])

    def test_mixed_change_adds_every_gate_once_with_its_first_path(self):
        self.assertEqual(selected('modbench/src/a.ts', 'MEditService/X/A.cs', 'modbench/src/b.ts', 'docs/x.md'), [
            '--frontend modbench/src/a.ts',
            '--backend MEditService/X/A.cs',
            '--api-drift MEditService/X/A.cs',
            '--scripts MEditService/X/A.cs',
            '--docs docs/x.md',
        ])


if __name__ == '__main__':
    unittest.main()
