"""LevelUpAgent output adapter for ComfyUI-See-through. No model code or weights."""
import json
import os
import re
import tempfile


class LevelUpSpineExport:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"parts": ("SEETHROUGH_PARTS",), "job_id": ("STRING", {"default": ""})}}

    RETURN_TYPES = ()
    FUNCTION = "export"
    CATEGORY = "LevelUpAgent/Spine"
    OUTPUT_NODE = True

    def export(self, parts, job_id):
        import folder_paths
        from PIL import Image

        if not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise ValueError("job_id must contain 32 lowercase hexadecimal characters")
        height, width = [int(v) for v in parts["frame_size"]]
        if not (1 <= width <= 8192 and 1 <= height <= 8192 and width * height <= 32 * 1024 * 1024):
            raise ValueError("Invalid layer canvas")
        entries = parts["tag2pinfo"]
        if not 1 <= len(entries) <= 128:
            raise ValueError("Expected 1–128 layers")
        output = folder_paths.get_output_directory()
        manifest = {"width": width, "height": height, "layers": []}
        # Stable descending depth is the See-through exporter draw order.
        for tag, info in sorted(entries.items(), key=lambda pair: pair[1].get("depth_median", 1), reverse=True):
            pixels = info.get("img")
            if pixels is None:
                continue
            image = Image.fromarray(pixels).convert("RGBA")
            x1, y1, x2, y2 = map(int, info.get("xyxy", [0, 0, image.width, image.height]))
            if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height) or image.size != (x2 - x1, y2 - y1):
                raise ValueError(f"Invalid layer bounds: {tag}")
            filename = f"levelup_spine_{job_id}_{len(manifest['layers']):03d}.png"
            # Names from models never become filesystem paths.
            descriptor, temporary = tempfile.mkstemp(prefix=".levelup-spine-", suffix=".png", dir=output)
            os.close(descriptor)
            try:
                image.save(temporary, format="PNG")
                os.replace(temporary, os.path.join(output, filename))
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            manifest["layers"].append({"name": str(tag), "filename": filename, "left": x1, "top": y1,
                                      "right": x2, "bottom": y2, "depth_median": float(info.get("depth_median", 1))})
        if not manifest["layers"]:
            raise ValueError("No layers were produced")
        text = json.dumps(manifest, ensure_ascii=False, allow_nan=False)
        descriptor, temporary = tempfile.mkstemp(prefix=".levelup-spine-", suffix=".json", dir=output)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                file.write(text)
            os.replace(temporary, os.path.join(output, f"levelup_spine_{job_id}_layers.json"))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"ui": {"levelup_spine": [manifest]}, "result": ()}


NODE_CLASS_MAPPINGS = {"LevelUpSpineExport": LevelUpSpineExport}
NODE_DISPLAY_NAME_MAPPINGS = {"LevelUpSpineExport": "LevelUpAgent Spine Layers"}
