#!/usr/bin/env python3
"""Reads docs/architecture/layers.d2 and the boxes docs/architecture/target-architecture.d2
draws, then checks every project reference on both sides and every trace message against the
layer rule. Prints the file and the pair for each mismatch. Exit 0 on a clean pass, 1 otherwise."""
import re
import sys
from pathlib import Path

ARROW_RE = re.compile(
    r'^(?P<src>[\w.]+)\s*->\s*(?P<dst>[\w.]+)\s*:?\s*'
    r'(?P<label>"[^"]*"|[^{]*)?\s*(\{(?P<attrs>[^}]*)\})?\s*$'
)
CLASS_RE = re.compile(r'class:\s*(\w+)')
BAND_RE = re.compile(r'^(?P<id>\w+):\s*"[^"]*"\s*\{class:\s*band\}')
CONTAINER_RE = re.compile(r'^(?P<column>\w+)_(?P<band>\w+):\s*"')
MEMBER_RE = re.compile(r'^(?P<indent> +)(?P<id>\w+):\s*"')
IMPORT_RE = re.compile(r'^(?P<alias>\w+):\s*@\.\./target-architecture\.(?P<id>[\w.]+)$')
WILDCARD_RE = re.compile(r'^(?P<alias>\w+):\s*"[^"]*"\s*\{class:\s*(?P<band>\w+)\}$')
TS_REFERENCE_RE = re.compile(r'"path":\s*"([^"]+)"')
CS_REFERENCE_RE = re.compile(r'<ProjectReference\s+Include="([^"]+)"')

ROOT_BOX = 'activation'
LAYERS = 'docs/architecture/layers.d2'
ZOOM_OUT = 'docs/architecture/target-architecture.d2'


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


class Rule:
    """The layer rule: the bands, the band pairs a reference may join, the band pairs a
    watch or push joins, and the box pairs named as exceptions."""

    def __init__(self, layers_path: Path):
        self.bands = []
        self.references = set()
        self.channels = set()
        self.exceptions = set()
        for line in layers_path.read_text().splitlines():
            m = BAND_RE.match(line.strip())
            if m:
                self.bands.append(m.group('id'))
        for a in parse_arrows(layers_path):
            if a.src in self.bands and a.dst in self.bands:
                (self.references if a.cls == 'ref' else self.channels).add((a.src, a.dst))
            else:
                self.exceptions.add((a.src, a.dst))

    def permits(self, src_id: str, dst_id: str):
        """A reference from one box to another: a part of the same box, a named exception, a
        lower band of its column, or its band's lib."""
        if top2(src_id) == top2(dst_id):
            return True
        if (top2(src_id), top2(dst_id)) in self.exceptions:
            return True
        if column_of(src_id) != column_of(dst_id):
            return False
        if (band_of(src_id), band_of(dst_id)) in self.references:
            return True
        return reaches_its_bands_lib(src_id, dst_id)

    def joins(self, src_id: str, dst_id: str):
        """A trace message between two boxes: a reference either way, since a reply takes
        its request's class, a watch or push either way, or two parts of one box."""
        if self.permits(src_id, dst_id) or self.permits(dst_id, src_id):
            return True
        return column_of(src_id) == column_of(dst_id) and self.bands_channel(band_of(src_id), band_of(dst_id))

    def bands_join(self, src_band: str, dst_band: str):
        pair, back = (src_band, dst_band), (dst_band, src_band)
        return pair in self.references or back in self.references or self.bands_channel(src_band, dst_band)

    def bands_channel(self, src_band: str, dst_band: str):
        return (src_band, dst_band) in self.channels or (dst_band, src_band) in self.channels


def band_of(box_id: str):
    return box_id.split('.')[0].split('_', 1)[1]


def column_of(box_id: str):
    return box_id.split('.')[0].split('_', 1)[0]


def top2(box_id: str):
    return '.'.join(box_id.split('.')[:2])


def reaches_its_bands_lib(src_id: str, dst_id: str):
    """target-architecture.md: a box references its band's lib by the band's rule."""
    s, d = top2(src_id), top2(dst_id)
    return s.split('.')[0] == d.split('.')[0] and d.split('.')[-1].endswith('lib')


def load_boxes(zoom_out: Path):
    """Every box the zoom-out draws, a part of a box included, by column and name:
    {'medit': {'index': 'medit_readmodel.index', 'queries': 'medit_readmodel.index.queries'}}."""
    boxes = {}
    column, path = None, []
    for line in zoom_out.read_text().splitlines():
        m = CONTAINER_RE.match(line)
        if m:
            column, path = m.group('column'), [f'{m.group("column")}_{m.group("band")}']
            continue
        m = MEMBER_RE.match(line)
        if m and column:
            depth = len(m.group('indent')) // 2
            path = path[:depth] + [m.group('id')]
            boxes.setdefault(column, {})[m.group('id')] = '.'.join(path)
    return boxes


def modbench_projects(root: Path):
    """(project file, box name, [referenced box names]) for the composition root, every box
    folder under modbench/src that holds a tsconfig, and the webview project; a test folder is
    no box."""
    src = root / 'modbench' / 'src'
    projects = []
    for path in sorted(src.glob('*/tsconfig.json')) + [src / 'tsconfig.json', root / 'modbench' / 'webview' / 'tsconfig.json']:
        if not path.exists() or path.parent.name == 'test':
            continue
        name = ROOT_BOX if path.parent == src else path.parent.name.lower()
        refs = [Path(p).name.lower() for p in TS_REFERENCE_RE.findall(path.read_text())]
        projects.append((path, name, refs))
    return projects


def medit_projects(root: Path):
    """(project file, box name, [referenced box names]) for every production csproj."""
    projects = []
    for path in sorted((root / 'MEditService').glob('MEditService.*/MEditService.*.csproj')):
        segments = path.stem.split('.')
        if any(s in ('Tests', 'TestSupport') for s in segments):
            continue
        name = segments[-1].lower()
        refs = [Path(p.replace('\\', '/')).stem.split('.')[-1].lower() for p in CS_REFERENCE_RE.findall(path.read_text())]
        projects.append((path, name, refs))
    return projects


def check_projects(root: Path, column: str, projects, boxes, rule: Rule):
    failures = []
    known = boxes.get(column, {})

    def rel(path):
        return str(path.relative_to(root))

    for path, name, refs in projects:
        if name not in known:
            failures.append(f"{rel(path)}: {name} is no box {ZOOM_OUT} draws in the {column} column")
            continue
        for ref in refs:
            if ref not in known:
                failures.append(f"{rel(path)}: {name} -> {ref}: {ref} is no box {ZOOM_OUT} draws in the {column} column")
            elif not rule.permits(known[name], known[ref]):
                failures.append(
                    f"{rel(path)}: {name} -> {ref}: a reference points to a lower layer of its column or "
                    f"its column's kernel, or its band's lib, or is a named exception ({LAYERS})"
                )
    return failures


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


def message_allowed(src, dst, msg_class, rule: Rule):
    if msg_class == 'outside':
        return True
    (src_kind, src_val), (dst_kind, dst_val) = src, dst
    if src_kind == 'real' and dst_kind == 'real':
        return rule.joins(src_val, dst_val)
    src_band = src_val if src_kind == 'wildcard' else band_of(src_val)
    dst_band = dst_val if dst_kind == 'wildcard' else band_of(dst_val)
    return rule.bands_join(src_band, dst_band)


def check_traces(traces_dir: Path, rule: Rule):
    failures = []
    for path in sorted(traces_dir.glob('*.d2')):
        actors = parse_trace_actors(path)
        for a in parse_arrows(path):
            if a.src not in actors or a.dst not in actors:
                failures.append(f"{a.where()}: undeclared actor in this trace")
                continue
            if not message_allowed(actors[a.src], actors[a.dst], a.cls, rule):
                failures.append(f"{a.where()}: no layer rule joins these two boxes ({LAYERS})")
    return failures


def run(root: Path):
    rule = Rule(root / LAYERS)
    boxes = load_boxes(root / ZOOM_OUT)
    failures = check_projects(root, 'modbench', modbench_projects(root), boxes, rule)
    failures += check_projects(root, 'medit', medit_projects(root), boxes, rule)
    traces_dir = root / 'docs' / 'architecture' / 'traces'
    if traces_dir.is_dir():
        failures += check_traces(traces_dir, rule)
    return failures


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    root = Path(argv[0]) if argv else Path(__file__).resolve().parents[3]
    failures = run(root)
    for failure in failures:
        print(failure)
    if failures:
        print("--- LAYER CHECK FAILED ---")
        return 1
    print(f"=== Projects and traces match {LAYERS} ===")
    return 0


if __name__ == '__main__':
    sys.exit(main())
