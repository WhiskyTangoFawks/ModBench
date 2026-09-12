"""Pins check-layers.py: the reference view against docs/architecture/layers.d2, and every
trace message against the reference view."""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_layers as cl  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]

LAYERS_D2 = """...@styles
grid-rows: 6
drivers: "Drivers" {class: band}
driving: "Driving adapters" {class: band}
core: "Core" {class: band}
kernel: "Kernel" {class: band}
driven: "Driven adapters" {class: band}
data: "Systems of record" {class: band}

drivers -> driving: {class: ref}
drivers -> core: {class: ref}
drivers -> kernel: {class: ref}
drivers -> driven: {class: ref}
drivers -> data: {class: ref}
driving -> core: {class: ref}
driving -> kernel: {class: ref}
driving -> driven: {class: ref}
driving -> data: {class: ref}
core -> kernel: {class: ref}
core -> driven: {class: ref}
core -> data: {class: ref}
driven -> data: {class: ref}

data -> driving: "watch" {class: signal}
kernel -> driving: "push" {class: push}

fx_driven.index -> fx_driven.sourcerepo: "same band"
"""


def write(root: pathlib.Path, relpath: str, content: str) -> pathlib.Path:
    path = root / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def make_fixture(tmp: pathlib.Path, reference_body: str, trace_files: dict):
    write(tmp, "docs/architecture/layers.d2", LAYERS_D2)
    write(
        tmp,
        "docs/architecture/target-architecture-references.d2",
        "...@target-architecture\n" + reference_body,
    )
    for name, body in trace_files.items():
        write(tmp, f"docs/architecture/traces/{name}.d2", body)
    return tmp


class ReferenceViewAgainstLayers(unittest.TestCase):
    def test_reference_pointing_to_a_lower_band_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_driving.a -> fx_core.b {class: ref}\n",
                {},
            )
            self.assertEqual(cl.run(root), [])

    def test_reference_into_its_own_columns_kernel_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_driven.a -> fx_kernel.b {class: ref}\n",
                {},
            )
            self.assertEqual(cl.run(root), [])

    def test_named_same_band_exception_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_driven.index -> fx_driven.sourcerepo {class: ref}\n",
                {},
            )
            self.assertEqual(cl.run(root), [])

    def test_reference_pointing_up_fails_naming_the_file_and_the_arrow(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_data.a -> fx_driving.b {class: ref}\n",
                {},
            )
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            failure = failures[0]
            self.assertIn("target-architecture-references.d2", failure)
            self.assertIn("fx_data.a -> fx_driving.b", failure)
            self.assertIn("layers.d2", failure)

    def test_same_band_pair_not_named_in_layers_still_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_driving.a -> fx_driving.b {class: ref}\n",
                {},
            )
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn("fx_driving.a -> fx_driving.b", failures[0])

    def test_store_and_outside_arrows_are_not_reference_direction_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_driven.a -> fx_data.a {class: store}\n"
                "fx_core.a -> fx_driving.a {class: outside}\n",
                {},
            )
            self.assertEqual(cl.run(root), [])


class TraceMessagesAgainstReferenceView(unittest.TestCase):
    def actor_block(self, alias, full_id, label=None):
        lines = [f"{alias}: @../target-architecture.{full_id}"]
        if label:
            lines.append(f"{alias}.label: {label}")
        return "\n".join(lines)

    def test_message_with_a_drawn_reference_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace = (
                "...@../styles\nshape: sequence_diagram\n"
                + self.actor_block("a", "fx_driving.a")
                + "\n"
                + self.actor_block("b", "fx_core.b")
                + "\na -> b: envelope {class: edit}\n"
            )
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_driving.a -> fx_core.b {class: ref}\n",
                {"one": trace},
            )
            self.assertEqual(cl.run(root), [])

    def test_message_with_no_allowed_pair_fails_naming_the_arrow(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace = (
                "...@../styles\nshape: sequence_diagram\n"
                + self.actor_block("a", "fx_driving.a")
                + "\n"
                + self.actor_block("b", "fx_driving.c")
                + "\na -> b: a stray call {class: edit}\n"
            )
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_driving.a -> fx_core.b {class: ref}\n",
                {"one": trace},
            )
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            failure = failures[0]
            self.assertIn("traces/one.d2", failure)
            self.assertIn("a -> b", failure)

    def test_message_classed_outside_always_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace = (
                "...@../styles\nshape: sequence_diagram\n"
                + self.actor_block("a", "fx_driving.a")
                + "\n"
                + self.actor_block("b", "fx_driving.c")
                + "\na -> b: bytes, at any time {class: outside}\n"
            )
            root = make_fixture(pathlib.Path(tmp), "", {"one": trace})
            self.assertEqual(cl.run(root), [])

    def test_composition_root_passes_with_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace = (
                "...@../styles\nshape: sequence_diagram\n"
                + self.actor_block("http", "medit_driving.http")
                + "\n"
                + self.actor_block("b", "fx_driving.c")
                + "\nb -> http: envelope {class: edit}\n"
            )
            root = make_fixture(pathlib.Path(tmp), "", {"one": trace})
            self.assertEqual(cl.run(root), [])

    def test_core_or_driven_box_reaches_any_kernel_box_of_its_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace = (
                "...@../styles\nshape: sequence_diagram\n"
                + self.actor_block("commands", "fx_core.commands")
                + "\n"
                + self.actor_block("codec", "fx_kernel.codec")
                + "\ncommands -> codec: schema {class: query}\n"
            )
            root = make_fixture(pathlib.Path(tmp), "", {"one": trace})
            self.assertEqual(cl.run(root), [])

    def test_two_sub_boxes_of_one_box_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace = (
                "...@../styles\nshape: sequence_diagram\n"
                + self.actor_block("projector", "fx_driven.index.projector")
                + "\n"
                + self.actor_block("store", "fx_driven.index.store")
                + "\nprojector -> store: rows {class: query}\n"
            )
            root = make_fixture(pathlib.Path(tmp), "", {"one": trace})
            self.assertEqual(cl.run(root), [])

    def test_a_box_with_a_store_arrow_passes_either_direction(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace = (
                "...@../styles\nshape: sequence_diagram\n"
                + self.actor_block("a", "fx_driven.a")
                + "\n"
                + self.actor_block("d", "fx_data.d")
                + "\nd -> a: bytes {class: signal}\n"
            )
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_driven.a -> fx_data.d {class: store}\n",
                {"one": trace},
            )
            self.assertEqual(cl.run(root), [])

    def test_wildcard_actor_resolves_via_its_band(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace = (
                "...@../styles\nshape: sequence_diagram\n"
                + self.actor_block("a", "fx_driven.a")
                + '\nviews: "every view" {class: driving}\n'
                + "a -> views: value {class: loadout}\n"
            )
            root = make_fixture(
                pathlib.Path(tmp),
                "fx_driving.b -> fx_driven.a {class: ref}\n",
                {"one": trace},
            )
            self.assertEqual(cl.run(root), [])

    def test_wildcard_actor_with_no_matching_box_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace = (
                "...@../styles\nshape: sequence_diagram\n"
                + self.actor_block("a", "fx_driven.a")
                + '\nviews: "every view" {class: driving}\n'
                + "a -> views: value {class: loadout}\n"
            )
            root = make_fixture(pathlib.Path(tmp), "", {"one": trace})
            failures = cl.run(root)
            self.assertEqual(len(failures), 1)
            self.assertIn("a -> views", failures[0])


# Three pairs not covered by the six allowed pairs, found in the traces committed at 975f2bc5.
# Reported as findings, not patched around.
REPORTED_GAP_PAIRS = {"instance -> client", "watcher -> plugins", "plugins -> source"}


class RealRepoDiagrams(unittest.TestCase):
    def test_the_committed_diagrams_report_the_gaps_by_file_line_and_arrow_and_fail(self):
        failures = cl.run(REPO_ROOT)
        pairs = set()
        for failure in failures:
            self.assertIn("no allowed pair covers this message", failure)
            self.assertRegex(failure.split(": ", 1)[0], r"\.d2:\d+$")
            pairs.add(failure.split(": ", 2)[1])
        self.assertEqual(pairs, REPORTED_GAP_PAIRS)
        self.assertEqual(cl.main([str(REPO_ROOT)]), 1)


if __name__ == "__main__":
    unittest.main()
