"""Pins check_layers.py: every project reference on both sides against docs/architecture/layers.d2,
and every trace message against the same rule."""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_layers as cl  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]

LAYERS_D2 = """...@styles
grid-rows: 7
drivers: "Drivers" {class: band}
driving: "Driving adapters" {class: band}
core: "Core" {class: band}
kernel: "Kernel" {class: band}
readmodel: "Read model" {class: band}
repositories: "Repositories" {class: band}
data: "Systems of record" {class: band}

drivers -> driving: {class: ref}
drivers -> core: {class: ref}
drivers -> kernel: {class: ref}
drivers -> readmodel: {class: ref}
drivers -> repositories: {class: ref}
driving -> core: {class: ref}
driving -> kernel: {class: ref}
driving -> readmodel: {class: ref}
driving -> repositories: {class: ref}
core -> kernel: {class: ref}
core -> repositories: {class: ref}
readmodel -> kernel: {class: ref}
readmodel -> repositories: {class: ref}
repositories -> kernel: {class: ref}
repositories -> data: {class: ref}

data -> repositories: "watch" {class: signal}
kernel -> readmodel: "watch" {class: signal}
repositories -> readmodel: "watch" {class: signal}
kernel -> driving: "push" {class: push}

medit_kernel.ports -> medit_kernel.loadorder: "same band"
modbench_repositories.client -> medit_driving.http: "the wire" {class: outside}
"""

ZOOM_OUT_D2 = """...@styles
grid-rows: 7
medit_driving: "MEDIT · Driving adapters" {
  class: band; grid-rows: 1
  http: "HTTP endpoints" {class: driving}
}
modbench_drivers: "MODBENCH · Drivers" {
  class: band; grid-rows: 1
  activation: "Activation" {class: driving}
}
modbench_driving: "MODBENCH · Driving adapters" {
  class: band; grid-rows: 1
  mods: "Mods" {class: driving}
  plugins: "Plugins" {class: driving}
  drivinglib: "driving lib" {class: driving}
}
medit_core: "MEDIT · Core" {
  class: band; grid-rows: 1
  commands: "Commands" {class: core}
  queries: "Queries" {class: core}
}
modbench_core: "MODBENCH · Core" {
  class: band; grid-rows: 1
  modlist: "modlist commands" {class: core}
}
medit_kernel: "MEDIT · Kernel" {
  class: band; grid-rows: 1
  loadorder: "Load order state" {class: kernel}
  codec: "Codec + schema" {class: kernel}
  ports: "Ports" {class: kernel}
}
modbench_kernel: "MODBENCH · Kernel" {
  class: band; grid-rows: 1
  ports: "Ports" {class: kernel}
  tables: "per-release tables" {class: kernel}
}
medit_readmodel: "MEDIT · Read model" {
  class: band; grid-rows: 1
  index: "Record index" {
    queries: "Queries" {class: readmodel}
    indexer: "Indexer" {class: readmodel}
    store: "Store" {class: derived}
  }
}
modbench_readmodel: "MODBENCH · Read model" {
  class: band; grid-rows: 1
  instanceloader: "Instance loader" {class: readmodel}
}
medit_repositories: "MEDIT · Repositories" {
  class: band; grid-rows: 1
  sourceadapter: "Source adapter" {class: repositories}
  pluginadapter: "Plugin adapter" {class: repositories}
}
modbench_repositories: "MODBENCH · Repositories" {
  class: band; grid-rows: 1
  instanceadapter: "Instance adapter" {class: repositories}
  client: "mEdit client" {class: repositories}
  deployment: "deployment" {class: repositories}
}
medit_data: "MEDIT · Systems of record" {
  class: band; grid-rows: 1
  source: "Source tree in git" {class: sor}
}
modbench_data: "MODBENCH · Systems of record" {
  class: band; grid-rows: 1
  instance: "Instance" {class: sor}
}
"""


def write(root: pathlib.Path, relpath: str, content: str) -> pathlib.Path:
    path = root / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def tsconfig(root: pathlib.Path, folder: str, references):
    """A Modbench box project; folder '' is the composition root at modbench/src."""
    prefix = './' if folder == '' else '../'
    refs = ',\n'.join(f'    {{ "path": "{prefix}{r}" }}' for r in references)
    body = (
        '{\n  "extends": "../tsconfig.box.json",\n'
        '  // a comment, as the real files carry\n'
        f'  "references": [\n{refs}\n  ],\n  "include": ["**/*.ts"]\n}}\n'
    )
    rel = 'modbench/src/tsconfig.json' if folder == '' else f'modbench/src/{folder}/tsconfig.json'
    write(root, rel, body)


def csproj(root: pathlib.Path, name: str, references):
    refs = '\n'.join(
        f'    <ProjectReference Include="..\\MEditService.{r}\\MEditService.{r}.csproj" />' for r in references
    )
    body = f'<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n{refs}\n  </ItemGroup>\n</Project>\n'
    write(root, f'MEditService/MEditService.{name}/MEditService.{name}.csproj', body)


def fixture(tmp: pathlib.Path, traces=None):
    write(tmp, 'docs/architecture/layers.d2', LAYERS_D2)
    write(tmp, 'docs/architecture/target-architecture.d2', ZOOM_OUT_D2)
    for name, body in (traces or {}).items():
        write(tmp, f'docs/architecture/traces/{name}.d2', body)
    return tmp


class ModbenchProjectReferencesAgainstLayers(unittest.TestCase):
    def test_a_reference_to_a_lower_band_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            tsconfig(root, 'mods', ['modlist', 'instanceLoader'])
            tsconfig(root, 'modlist', ['instanceAdapter'])
            self.assertEqual(cl.run(root), [])

    def test_a_reference_pointing_up_fails_naming_the_project_file_and_the_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            tsconfig(root, 'instanceAdapter', ['mods'])
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('modbench/src/instanceAdapter/tsconfig.json', failures[0])
            self.assertIn('instanceadapter -> mods', failures[0])
            self.assertIn('layers.d2', failures[0])

    def test_a_same_band_reference_not_named_in_layers_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            tsconfig(root, 'mods', ['plugins'])
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('mods -> plugins', failures[0])

    def test_a_reference_to_its_bands_lib_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            tsconfig(root, 'mods', ['drivingLib'])
            self.assertEqual(cl.run(root), [])

    def test_the_composition_root_is_the_activation_box(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            tsconfig(root, '', ['mods', 'modlist', 'instanceAdapter', 'tables'])
            self.assertEqual(cl.run(root), [])

    def test_a_project_the_zoom_out_does_not_draw_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            tsconfig(root, 'helpers', [])
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('modbench/src/helpers/tsconfig.json', failures[0])
            self.assertIn('target-architecture.d2', failures[0])

    def test_a_box_the_code_has_not_built_yet_is_no_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            tsconfig(root, 'mods', [])
            self.assertEqual(cl.run(root), [])


class MEditProjectReferencesAgainstLayers(unittest.TestCase):
    def test_a_reference_to_the_kernel_and_a_repository_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            csproj(root, 'Commands', ['Codec', 'Ports', 'SourceAdapter'])
            self.assertEqual(cl.run(root), [])

    def test_a_named_same_band_exception_passes_and_its_sibling_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            csproj(root, 'Ports', ['LoadOrder'])
            csproj(root, 'Codec', ['LoadOrder'])
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('MEditService.Codec.csproj', failures[0])
            self.assertIn('codec -> loadorder', failures[0])

    def test_test_side_projects_are_not_boxes_and_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            csproj(root, 'Commands.Tests', ['Commands', 'TestSupport'])
            csproj(root, 'TestSupport', ['Codec'])
            self.assertEqual(cl.run(root), [])

    def test_the_core_never_references_the_read_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            csproj(root, 'Commands', ['Index'])
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('commands -> index', failures[0])

    def test_a_part_of_a_box_references_its_parent_and_its_siblings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            csproj(root, 'Queries', ['Index', 'Codec'])
            self.assertEqual(cl.run(root), [])

    def test_a_reference_across_the_columns_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fixture(pathlib.Path(tmp))
            csproj(root, 'Commands', ['Tables'])
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('commands -> tables', failures[0])


class TraceMessagesAgainstLayers(unittest.TestCase):
    def actor(self, alias, full_id):
        return f"{alias}: @../target-architecture.{full_id}\n"

    def trace(self, *lines):
        return "...@../styles\nshape: sequence_diagram\n" + "".join(lines)

    def test_a_message_the_rule_permits_passes_in_both_directions(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('mods', 'modbench_driving.mods'),
                self.actor('modlist', 'modbench_core.modlist'),
                "mods -> modlist: the gesture {class: edit}\n",
                "modlist -> mods: applied or refusal {class: edit}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            self.assertEqual(cl.run(root), [])

    def test_a_message_between_two_boxes_no_rule_joins_fails_naming_the_trace(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('mods', 'modbench_driving.mods'),
                self.actor('plugins', 'modbench_driving.plugins'),
                "mods -> plugins: a stray call {class: edit}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('traces/one.d2', failures[0])
            self.assertIn('mods -> plugins', failures[0])

    def test_an_actor_with_no_project_yet_is_checked_against_the_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('modlist', 'modbench_core.modlist'),
                self.actor('deployment', 'modbench_repositories.deployment'),
                "modlist -> deployment: the winners {class: deploy}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            self.assertEqual(cl.run(root), [])

    def test_an_actor_with_no_project_yet_still_fails_the_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('deployment', 'modbench_repositories.deployment'),
                self.actor('client', 'modbench_repositories.client'),
                "deployment -> client: a stray call {class: edit}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('deployment -> client', failures[0])

    def test_a_watch_runs_from_a_system_of_record_into_a_repository(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('instance', 'modbench_data.instance'),
                self.actor('adapter', 'modbench_repositories.instanceadapter'),
                "instance -> adapter: changed {class: signal}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            self.assertEqual(cl.run(root), [])

    def test_the_wire_between_the_processes_is_a_named_exception(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('client', 'modbench_repositories.client'),
                self.actor('http', 'medit_driving.http'),
                "client -> http: the edit {class: edit}\n",
                "http -> client: applied or refusal {class: edit}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            self.assertEqual(cl.run(root), [])

    def test_a_message_classed_outside_always_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('mods', 'modbench_driving.mods'),
                self.actor('plugins', 'modbench_driving.plugins'),
                "mods -> plugins: bytes, at any time {class: outside}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            self.assertEqual(cl.run(root), [])

    def test_two_sub_boxes_of_one_box_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('indexer', 'medit_readmodel.index.indexer'),
                self.actor('store', 'medit_readmodel.index.store'),
                "indexer -> store: rows {class: query}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            self.assertEqual(cl.run(root), [])

    def test_a_wildcard_actor_takes_its_bands_reach(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('loader', 'modbench_readmodel.instanceloader'),
                'views: "every view" {class: driving}\n',
                "loader -> views: value {class: loadorder}\n",
                "views -> loader: refresh {class: signal}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            self.assertEqual(cl.run(root), [])

    def test_a_wildcard_actor_reaching_across_its_own_band_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('mods', 'modbench_driving.mods'),
                'views: "every view" {class: driving}\n',
                "views -> mods: a stray call {class: edit}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('views -> mods', failures[0])

    def test_an_undeclared_actor_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.trace(
                self.actor('mods', 'modbench_driving.mods'),
                "mods -> ghost: a call {class: edit}\n",
            )
            root = fixture(pathlib.Path(tmp), {'one': body})
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn('undeclared actor', failures[0])


class RealRepo(unittest.TestCase):
    def test_the_committed_projects_and_diagrams_pass_the_checker(self):
        self.assertEqual(cl.run(REPO_ROOT), [])
        self.assertEqual(cl.main([str(REPO_ROOT)]), 0)


if __name__ == "__main__":
    unittest.main()
