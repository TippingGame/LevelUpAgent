"""Contract tests using synthetic arrays; no ComfyUI, models or GPU required."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
import numpy as np
from PIL import Image

SPEC = importlib.util.spec_from_file_location("spine_bridge", pathlib.Path(__file__).parents[1] / "modules/spine_comfy_bridge/__init__.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
JOB = "0123456789abcdef0123456789abcdef"


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = types.SimpleNamespace(get_output_directory=lambda: self.directory.name)

    def tearDown(self):
        if self.previous is None:
            del sys.modules["folder_paths"]
        else:
            sys.modules["folder_paths"] = self.previous
        self.directory.cleanup()

    def parts(self):
        pixels = np.zeros((10, 20, 4), dtype=np.uint8)
        pixels[2:8, 3:17] = [20, 100, 180, 128]
        return {"frame_size": (100, 120), "tag2pinfo": {
            "front": {"img": pixels, "xyxy": [20, 30, 40, 40], "depth_median": .2},
            "back": {"img": pixels, "xyxy": [40, 50, 60, 60], "depth_median": .8},
            "tie": {"img": pixels, "xyxy": [50, 50, 70, 60], "depth_median": .8},
        }}

    def test_history_manifest_order_geometry_and_alpha(self):
        result = MODULE.LevelUpSpineExport().export(self.parts(), JOB)
        manifest = result["ui"]["levelup_spine"][0]
        self.assertEqual([layer["name"] for layer in manifest["layers"]], ["back", "tie", "front"])
        self.assertEqual((manifest["width"], manifest["height"]), (120, 100))
        for index, layer in enumerate(manifest["layers"]):
            self.assertEqual(layer["filename"], f"levelup_spine_{JOB}_{index:03d}.png")
            with Image.open(pathlib.Path(self.directory.name) / layer["filename"]) as image:
                self.assertEqual(image.size, (20, 10))
                self.assertEqual(image.getpixel((3, 2))[3], 128)
                self.assertEqual(image.getpixel((0, 0))[3], 0)
        saved = json.loads((pathlib.Path(self.directory.name) / f"levelup_spine_{JOB}_layers.json").read_text(encoding="utf8"))
        self.assertEqual(saved, manifest)
        self.assertEqual(len(list(pathlib.Path(self.directory.name).iterdir())), 4)

    def test_job_ids_and_model_names_cannot_escape_output(self):
        with self.assertRaises(ValueError):
            MODULE.LevelUpSpineExport().export(self.parts(), "../../evil")
        parts = self.parts()
        parts["tag2pinfo"] = {"../../evil": parts["tag2pinfo"]["front"]}
        result = MODULE.LevelUpSpineExport().export(parts, JOB)
        self.assertEqual(result["ui"]["levelup_spine"][0]["layers"][0]["filename"], f"levelup_spine_{JOB}_000.png")

    def test_bounds_empty_and_canvas_limits(self):
        for mutate in [lambda p: p.update(frame_size=(9000, 9000)), lambda p: p.update(tag2pinfo={}), lambda p: p["tag2pinfo"]["front"].update(xyxy=[0, 0, 30, 40])]:
            parts = self.parts()
            mutate(parts)
            with self.assertRaises(ValueError):
                MODULE.LevelUpSpineExport().export(parts, JOB)

    def test_jobs_do_not_share_a_latest_result_pointer(self):
        a = MODULE.LevelUpSpineExport().export(self.parts(), JOB)
        b = MODULE.LevelUpSpineExport().export(self.parts(), "b" * 32)
        first = {l["filename"] for l in a["ui"]["levelup_spine"][0]["layers"]}
        second = {l["filename"] for l in b["ui"]["levelup_spine"][0]["layers"]}
        self.assertFalse(first & second)


if __name__ == "__main__":
    unittest.main()
