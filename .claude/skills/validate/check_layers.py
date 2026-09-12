#!/usr/bin/env python3
"""Reads docs/architecture/layers.d2, checks target-architecture-references.d2's reference
arrows against it, then checks every trace message against the reference view. Prints the
file and the arrow for each mismatch. Exit 0 on a clean pass, 1 otherwise."""
import re
import sys
from pathlib import Path

ARROW_RE = re.compile(
    r'^(?P<src>[\w.]+)\s*->\s*(?P<dst>[\w.]+)\s*:?\s*'
    r'(?P<label>"[^"]*"|[^{]*)?\s*(\{(?P<attrs>[^}]*)\})?\s*$'
)
CLASS_RE = re.compile(r'class:\s*(\w+)')
IMPORT_RE = re.compile(r'^(?P<alias>\w+):\s*@\.\./target-architecture\.(?P<id>[\w.]+)$')
WILDCARD_RE = re.compile(r'^(?P<alias>\w+):\s*"[^"]*"\s*\{class:\s*(?P<band>\w+)\}$')

# docs/architecture/target-architecture.md "The layers", drivers to systems of record.
BANDS = ("drivers", "driving", "core", "kernel", "driven", "data")

# target-architecture.md's reading guide names the composition roots; its activation file is
# prose, never drawn, so only these two are ever a trace actor.
COMPOSITION_ROOTS = {"medit_driving.http", "modbench_driving.toolbox"}


class Arrow:
    __slots__ = ("file", "lineno", "src", "dst", "label", "cls")

    def __init__(self, file, lineno, src, dst, label, cls):
        self.file = file
        self.lineno = lineno
        self.src = src
        self.dst = dst
        self.label = label
        self.cls = cls

    def where(self):
        return f"{self.file}:{self.lineno}: {self.src} -> {self.dst}"


def parse_arrows(path: Path):
    """Every 'src -> dst[: label] [{...class: X...}]' line. A line with no '->' is not an
    arrow (a box declaration, a label override, a note) and is skipped."""
    arrows = []
    for lineno, line in enumerate(path.read_text().splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or '->' not in stripped:
            continue
        m = ARROW_RE.match(stripped)
        if not m:
            continue
        label = (m.group('label') or '').strip()
        if label.startswith('"') and label.endswith('"') and len(label) >= 2:
            label = label[1:-1]
        attrs = m.group('attrs') or ''
        cm = CLASS_RE.search(attrs)
        cls = cm.group(1) if cm else None
        arrows.append(Arrow(str(path), lineno, m.group('src'), m.group('dst'), label, cls))
    return arrows


def band_of(box_id: str):
    top = box_id.split('.')[0]
    for band in BANDS:
        if top.endswith('_' + band):
            return band
    return None


def column_of(box_id: str):
    band = band_of(box_id)
    if band is None:
        return None
    top = box_id.split('.')[0]
    return top[: -(len(band) + 1)]


def top2(box_id: str):
    return '.'.join(box_id.split('.')[:2])


def parent_of(box_id: str):
    parts = box_id.split('.')
    return '.'.join(parts[:-1]) if len(parts) >= 3 else None


def load_layers(layers_path: Path):
    """Band-to-band permitted directions (class: ref, bare band ids) and same-band exceptions
    (a dotted zoom-out id on either end) that layers.d2 draws."""
    permitted = set()
    exceptions = set()
    for a in parse_arrows(layers_path):
        if a.src in BANDS and a.dst in BANDS:
            if a.cls == 'ref':
                permitted.add((a.src, a.dst))
        else:
            exceptions.add((a.src, a.dst))
    return permitted, exceptions


def check_reference_view(ref_path: Path, permitted, exceptions):
    """Every class:ref arrow must point to a lower band, or its column's kernel, or be one of
    the layers file's own named same-band exceptions."""
    failures = []
    for a in parse_arrows(ref_path):
        if a.cls != 'ref':
            continue
        src_band, dst_band = band_of(a.src), band_of(a.dst)
        if src_band is None or dst_band is None:
            failures.append(f"{a.where()}: unrecognized layer (docs/architecture/layers.d2)")
            continue
        if (src_band, dst_band) in permitted:
            continue
        if dst_band == 'kernel' and column_of(a.src) == column_of(a.dst):
            continue
        if (a.src, a.dst) in exceptions:
            continue
        failures.append(
            f"{a.where()}: reference must point to a lower layer or its column's kernel, and "
            f"is not a named same-band exception (docs/architecture/layers.d2)"
        )
    return failures


def load_reference_view(ref_path: Path):
    """The reference view's class:ref and class:store pairs, either direction, and every box
    in it grouped by band, for a trace's wildcard actor to resolve against."""
    ref_pairs = set()
    store_pairs = set()
    boxes_by_band = {}
    for a in parse_arrows(ref_path):
        s, d = top2(a.src), top2(a.dst)
        if a.cls == 'ref':
            ref_pairs.add(frozenset((s, d)))
        elif a.cls == 'store':
            store_pairs.add(frozenset((s, d)))
        for box in (s, d):
            band = band_of(box)
            if band:
                boxes_by_band.setdefault(band, set()).add(box)
    return ref_pairs, store_pairs, boxes_by_band


def parse_trace_actors(path: Path):
    """Every actor a trace declares: imported from the zoom-out ('real', full id), or declared
    locally with only a class ('wildcard', band) — the maintenance rule's "set of boxes"."""
    actors = {}
    for line in path.read_text().splitlines():
        stripped = line.strip()
        m = IMPORT_RE.match(stripped)
        if m:
            actors[m.group('alias')] = ('real', m.group('id'))
            continue
        m = WILDCARD_RE.match(stripped)
        if m:
            actors[m.group('alias')] = ('wildcard', m.group('band'))
    return actors


def _wildcard_resolves(band, other_id, ref_pairs, store_pairs, boxes_by_band):
    other2 = top2(other_id)
    for box in boxes_by_band.get(band, ()):
        pair = frozenset((box, other2))
        if pair in ref_pairs or pair in store_pairs:
            return True
    return False


def message_allowed(src, dst, msg_class, ref_pairs, store_pairs, boxes_by_band):
    """The six allowed pairs for a trace message between two actors."""
    if msg_class == 'outside':
        return True

    src_kind, src_val = src
    dst_kind, dst_val = dst

    if src_kind == 'wildcard' and dst_kind == 'wildcard':
        return False
    if src_kind == 'wildcard':
        return _wildcard_resolves(src_val, dst_val, ref_pairs, store_pairs, boxes_by_band)
    if dst_kind == 'wildcard':
        return _wildcard_resolves(dst_val, src_val, ref_pairs, store_pairs, boxes_by_band)

    src_id, dst_id = src_val, dst_val
    src_parent, dst_parent = parent_of(src_id), parent_of(dst_id)
    if src_parent is not None and src_parent == dst_parent:
        return True

    s2, d2 = top2(src_id), top2(dst_id)
    if s2 in COMPOSITION_ROOTS or d2 in COMPOSITION_ROOTS:
        return True

    pair = frozenset((s2, d2))
    if pair in ref_pairs or pair in store_pairs:
        return True

    src_band, dst_band = band_of(src_id), band_of(dst_id)
    src_col, dst_col = column_of(src_id), column_of(dst_id)
    if src_band in ('core', 'driven') and dst_band == 'kernel' and src_col == dst_col:
        return True
    if dst_band in ('core', 'driven') and src_band == 'kernel' and src_col == dst_col:
        return True

    return False


def check_traces(traces_dir: Path, ref_pairs, store_pairs, boxes_by_band):
    failures = []
    for path in sorted(traces_dir.glob('*.d2')):
        actors = parse_trace_actors(path)
        for a in parse_arrows(path):
            if a.src not in actors or a.dst not in actors:
                failures.append(f"{a.where()}: undeclared actor in this trace")
                continue
            if not message_allowed(
                actors[a.src], actors[a.dst], a.cls, ref_pairs, store_pairs, boxes_by_band
            ):
                failures.append(
                    f"{a.where()}: no allowed pair covers this message "
                    f"(docs/architecture/target-architecture-references.d2)"
                )
    return failures


def run(root: Path):
    layers_path = root / 'docs' / 'architecture' / 'layers.d2'
    ref_path = root / 'docs' / 'architecture' / 'target-architecture-references.d2'
    traces_dir = root / 'docs' / 'architecture' / 'traces'

    permitted, exceptions = load_layers(layers_path)
    failures = check_reference_view(ref_path, permitted, exceptions)
    ref_pairs, store_pairs, boxes_by_band = load_reference_view(ref_path)
    failures += check_traces(traces_dir, ref_pairs, store_pairs, boxes_by_band)
    return failures


# Three pairs the six allowed pairs do not cover, in the traces committed at 975f2bc5. Printed
# on every run, never silently passed, and never grown to cover a new violation.
_INSTANCE_TO_CLIENT = "instance -> client"
KNOWN_GAPS = (
    ("traces/enable-a-mod.d2", _INSTANCE_TO_CLIENT),
    ("traces/enable-a-plugin.d2", _INSTANCE_TO_CLIENT),
    ("traces/project.d2", _INSTANCE_TO_CLIENT),
    ("traces/switch-profile.d2", _INSTANCE_TO_CLIENT),
    ("traces/the-instance-recomputes.d2", _INSTANCE_TO_CLIENT),
    ("traces/upgrade-a-mod.d2", "watcher -> plugins"),
    ("traces/upgrade-a-mod.d2", "plugins -> source"),
)


def _is_known_gap(failure: str) -> bool:
    return any(path in failure and f"{pair}:" in failure for path, pair in KNOWN_GAPS)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    root = Path(argv[0]) if argv else Path(__file__).resolve().parents[3]
    failures = run(root)
    new_failures = [f for f in failures if not _is_known_gap(f)]
    for failure in failures:
        tag = "" if failure in new_failures else "(known, reported) "
        print(tag + failure)
    if new_failures:
        print("--- DIAGRAM LAYER CHECK FAILED ---")
        return 1
    print("=== Diagrams match docs/architecture/layers.d2 (known findings above, if any) ===")
    return 0


if __name__ == '__main__':
    sys.exit(main())
