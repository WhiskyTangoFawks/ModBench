import json
import logging
import sys
from pathlib import Path

LOGGER = logging.getLogger(__name__)
USAGE = "usage: name_files.py <plugin-source folder> <plugin file name> <vanilla path>"
RECORD_FOLDER = "MiscItems"
TEMPLATE_EDITOR_ID = "MBDevItemA"


def name_files(plugin_source: Path, plugin: str, vanilla_path: str) -> None:
    items = plugin_source / plugin / RECORD_FOLDER
    template: dict[str, object] = json.loads(next(items.glob(f"{TEMPLATE_EDITOR_ID} - *.json")).read_text())
    first_id = int(str(template["FormKey"]).split(":")[0], 16)
    named = [
        ("MBDevItemOwnFile", "MBDev\\Own.nif"),
        ("MBDevItemOtherModFile", "MBDev\\Other.nif"),
        ("MBDevItemVanillaFile", vanilla_path),
    ]
    for offset, (editor_id, model_file) in enumerate(named, start=1):
        form_id = f"{first_id + offset:06X}"
        record = {**template, "FormKey": f"{form_id}:{plugin}", "EditorID": editor_id, "Model": {"File": model_file}}
        (items / f"{editor_id} - {form_id}_{plugin}.json").write_text(json.dumps(record, indent=2) + "\n")


def main(arguments: list[str]) -> int:
    if len(arguments) != 3:
        LOGGER.error(USAGE)
        return 2
    plugin_source, plugin, vanilla_path = arguments
    name_files(Path(plugin_source), plugin, vanilla_path)
    return 0


if __name__ == "__main__":
    logging.basicConfig(format="%(message)s")
    sys.exit(main(sys.argv[1:]))
