"""Pins select_backend_tests.py: a changed path selects the test projects that reference its
project, read from the csproj files."""
import contextlib
import io
import json
import pathlib
import tempfile
import unittest

import select_backend_tests as sbt

TEST_SDK_REFERENCE = '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />'


def csproj(*items):
    return '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n' + ''.join(
        f'    {item}\n' for item in items) + '  </ItemGroup>\n</Project>\n'


def reference(project):
    return f'<ProjectReference Include="..\\{project}\\{project}.csproj" />'


def write_service(root: pathlib.Path):
    """Kernel <- Core <- Core.Tests; Kernel <- Kernel.Tests; Support links Kernel's data and is a
    test project itself."""
    service = root / 'MEditService'
    projects = {
        'Kernel': csproj(),
        'Core': csproj(reference('Kernel')),
        'Kernel.Tests': csproj(TEST_SDK_REFERENCE, reference('Kernel')),
        'Core.Tests': csproj(TEST_SDK_REFERENCE, reference('Core')),
        'Support': csproj(TEST_SDK_REFERENCE, '<None Include="..\\Data\\TestData\\**" LinkBase="TestData" />'),
        'Data': csproj(),
    }
    for name, body in projects.items():
        (service / name).mkdir(parents=True)
        (service / name / f'{name}.csproj').write_text(body)
    return service


class Selection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.service = write_service(pathlib.Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def select(self, *changed):
        return sbt.select(self.service, changed)

    def test_a_production_change_selects_every_test_project_that_reaches_it(self):
        self.assertEqual(self.select('MEditService/Kernel/Value.cs'), ['Core.Tests', 'Kernel.Tests'])

    def test_a_change_high_in_the_graph_selects_only_the_projects_above_it(self):
        self.assertEqual(self.select('MEditService/Core/Command.cs'), ['Core.Tests'])

    def test_a_test_project_change_selects_that_project(self):
        self.assertEqual(self.select('MEditService/Kernel.Tests/ValueTests.cs'), ['Kernel.Tests'])

    def test_a_linked_file_selects_the_project_that_links_it(self):
        self.assertEqual(self.select('MEditService/Data/TestData/plugin.esp'), ['Support'])

    def test_a_change_to_the_shared_build_inputs_selects_every_test_project(self):
        every = ['Core.Tests', 'Kernel.Tests', 'Support']
        self.assertEqual(self.select('MEditService/Directory.Build.props'), every)
        self.assertEqual(self.select('MEditService/MEditService.sln'), every)

    def test_a_change_outside_the_backend_or_to_its_markdown_selects_nothing(self):
        self.assertEqual(self.select('modbench/src/a.ts', 'MEditService/CLAUDE.md',
                                     'MEditService/Core/README.md'), [])

    def test_the_selection_is_the_union_over_every_changed_path(self):
        self.assertEqual(self.select('MEditService/Core/a.cs', 'MEditService/Data/TestData/b'),
                         ['Core.Tests', 'Support'])


class SolutionFilter(unittest.TestCase):
    def test_main_prints_the_selection_and_writes_it_as_a_solution_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = write_service(pathlib.Path(tmp))
            slnf = pathlib.Path(tmp) / 'selected.slnf'
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                sbt.main([str(service), str(slnf)], io.StringIO('MEditService/Core/a.cs\n'))
            self.assertEqual(printed.getvalue(), 'Core.Tests\n')
            self.assertEqual(
                json.loads(slnf.read_text()),
                {'solution': {'path': str(service / 'MEditService.sln'),
                              'projects': ['Core.Tests/Core.Tests.csproj']}})


class RealRepoGraph(unittest.TestCase):
    def test_a_commands_change_selects_the_commands_http_and_architecture_tests(self):
        service = pathlib.Path(__file__).resolve().parents[3] / 'MEditService'
        self.assertEqual(sbt.select(service, ['MEditService/MEditService.Commands/Edits/a.cs']),
                         ['MEditService.Architecture.Tests', 'MEditService.Commands.Tests', 'MEditService.Http.Tests'])


if __name__ == '__main__':
    unittest.main()
