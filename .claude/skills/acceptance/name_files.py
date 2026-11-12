"""name_files.py <plugin-source folder> <plugin file name> <vanilla path>: three records beside MBDevItemA, each naming a file."""
import json
import pathlib
import sys

folder, plugin, vanilla = sys.argv[1:]
items = pathlib.Path(folder, plugin, "MiscItems")
template = json.loads(next(items.glob("MBDevItemA - *.json")).read_text())
first_id = int(template["FormKey"].split(":")[0], 16)

named = [
    ("MBDevItemOwnFile", "MBDev\\Own.nif"),
    ("MBDevItemOtherModFile", "MBDev\\Other.nif"),
    ("MBDevItemVanillaFile", vanilla),
]
for offset, (editor_id, path) in enumerate(named, start=1):
    form_id = f"{first_id + offset:06X}"
    record = {**template, "FormKey": f"{form_id}:{plugin}", "EditorID": editor_id, "Model": {"File": path}}
    pathlib.Path(items, f"{editor_id} - {form_id}_{plugin}.json").write_text(json.dumps(record, indent=2) + "\n")
