"""Preflight and artifact boundary tests; fixtures are not generated 3D models."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("model3d_lab", Path(__file__).with_name("model3d_lab.py"))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


class Model3DLabTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="levelup model3d ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def glb(self, document=None, payload=None):
        document = document or {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 36}], "bufferViews": [{"buffer": 0, "byteLength": 36}], "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"}], "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}]}
        raw = json.dumps(document).encode()
        raw += b" " * (-len(raw) % 4)
        payload = payload if payload is not None else struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
        chunks = struct.pack("<I4s", len(raw), b"JSON") + raw + struct.pack("<I4s", len(payload), b"BIN\x00") + payload
        path = self.root / "fixture.glb"
        path.write_bytes(struct.pack("<4sII", b"glTF", 2, len(chunks) + 12) + chunks)
        return path, document

    def test_primary_weights_do_not_count_alternative_checkpoints(self):
        result = lab.sizing(lab.DEFAULT_MANIFEST)
        self.assertEqual(result["primaryWeightBytes"], 4823313502)
        self.assertEqual(len(result["files"]), 5)
        self.assertFalse(result["compressedInstallerIncrementMeasured"])

    def test_module_paths_reject_traversal_windows_drives_and_absolute_paths(self):
        for relative in ["../weights", "C:/outside.bin", "C:relative.bin", "/outside.bin", "folder\\..\\weights"]:
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                lab.contained_path(self.root, relative)
        self.assertEqual(lab.contained_path(self.root, "weights/model.bin"), self.root / "weights/model.bin")

    def test_weights_need_size_and_hash_not_just_a_filename(self):
        path = self.root / "model.bin"
        expected = b"correct"
        manifest = {"files": [{"path": path.name, "role": "weight", "bytes": len(expected), "sha256": hashlib.sha256(expected).hexdigest()}]}
        path.write_bytes(b"stub")
        self.assertEqual(lab.inspect_files(manifest, self.root, True)[0]["status"], "size_mismatch")
        path.write_bytes(b"invalid")
        self.assertEqual(lab.inspect_files(manifest, self.root, True)[0]["status"], "hash_mismatch")
        path.write_bytes(expected)
        self.assertEqual(lab.inspect_files(manifest, self.root, True)[0]["status"], "verified")

    def test_missing_environment_never_claims_inference_success(self):
        result = lab.doctor(lab.DEFAULT_MANIFEST, self.root, probe_hardware=False)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["runtime"]["status"], "missing")
        self.assertFalse(result["generationExecuted"])
        self.assertIn("inference_smoke_test_not_run", [x["code"] for x in result["blockers"]])

    def test_present_dependencies_still_require_a_real_smoke_test(self):
        manifest = lab.load_manifest(lab.DEFAULT_MANIFEST)
        with patch.object(lab, "inspect_files", return_value=[{"role": "weight", "status": "verified"}]), patch.object(lab, "python_probe", return_value={"status": "inspected", "version": [3, 10, 11], "imports": {key: True for key in manifest["runtime"]["imports"]}}):
            result = lab.doctor(lab.DEFAULT_MANIFEST, self.root, verify_hashes=True, probe_hardware=False)
        self.assertEqual(result["status"], "requires_smoke_test")
        self.assertFalse(result["generationExecuted"])

    def test_manifest_rejects_duplicate_file_accounting(self):
        manifest = lab.load_manifest(lab.DEFAULT_MANIFEST)
        manifest["files"].append(copy.deepcopy(manifest["files"][0]))
        path = self.root / "manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            lab.load_manifest(path)

    def test_plan_is_explicitly_not_a_running_job(self):
        result = lab.plan(lab.DEFAULT_MANIFEST, self.root, None)
        self.assertEqual(result["status"], "planned_not_executed")
        self.assertFalse(result["runnerImplemented"])
        self.assertTrue(result["inputRequired"])
        self.assertTrue(result["policy"]["allowMinorViewInconsistency"])

    def test_mislabeled_image_rejected(self):
        path = self.root / "fake.png"
        path.write_text("not an image")
        with self.assertRaisesRegex(ValueError, "PNG or JPEG"):
            lab.plan(lab.DEFAULT_MANIFEST, self.root, path)

    def test_mesh_container_is_not_unity_certification(self):
        path, _ = self.glb()
        result = lab.verify_glb(path)
        self.assertEqual(result["status"], "structural_check_passed")
        self.assertEqual(result["positionCountSummedPerPrimitive"], 3)
        self.assertFalse(result["unityImportVerified"])
        self.assertFalse(result["hasUVOnAllPrimitives"])

    def test_splat_only_container_is_not_a_game_mesh(self):
        path, _ = self.glb({"asset": {"version": "2.0"}, "extensionsUsed": ["KHR_gaussian_splatting"]})
        with self.assertRaisesRegex(ValueError, "no mesh primitives"):
            lab.verify_glb(path)

    def test_truncated_file_rejected(self):
        path, _ = self.glb()
        path.write_bytes(path.read_bytes()[:-1])
        with self.assertRaisesRegex(ValueError, "length mismatch"):
            lab.verify_glb(path)

    def test_fabricated_vertex_count_exceeding_binary_rejected(self):
        _, document = self.glb()
        document["accessors"][0]["count"] = 100000
        path, _ = self.glb(document)
        with self.assertRaisesRegex(ValueError, "buffer range"):
            lab.verify_glb(path)

    def test_invalid_embedded_buffer_length_rejected(self):
        _, document = self.glb()
        document["buffers"][0]["byteLength"] = 500
        path, _ = self.glb(document)
        with self.assertRaisesRegex(ValueError, "BIN chunk"):
            lab.verify_glb(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
