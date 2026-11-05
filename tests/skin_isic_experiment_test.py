import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "skin-isic-experiment.py"
spec = importlib.util.spec_from_file_location("skin_isic", SCRIPT)
skin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skin)


class SkinExperimentTests(unittest.TestCase):
    def test_budget_rejects_overruns_and_foreign_hosts(self):
        budget = skin.Budget(10)
        budget.consume(7)
        with self.assertRaises(ValueError):
            budget.consume(4)
        self.assertEqual(budget.used, 7)
        for url in ("http://api.isic-archive.com/api/v2/images/a", "https://example.com/image.jpg",
                    "https://api.isic-archive.com.attacker.test/api/v2/images/"):
            with self.assertRaisesRegex(ValueError, "Origen"):
                budget.fetch(url, 20)
        with self.assertRaises(ValueError):
            budget.consume(-1)

    def test_stream_counts_bytes_and_stops_before_oversized_download(self):
        class Response(io.BytesIO):
            headers = {"Content-Length": "5"}

        class Opener:
            def open(self, url, timeout):
                return Response(b"12345")

        with patch("urllib.request.build_opener", return_value=Opener()):
            budget = skin.Budget(10)
            self.assertEqual(budget.fetch(skin.API + "ISIC_0000000/", 6), b"12345")
            self.assertEqual(budget.used, 5)
            with self.assertRaises(skin.OversizedRemoteFile):
                budget.fetch(skin.API + "ISIC_0000000/", 4)
            self.assertEqual(budget.used, 5)
            budget.consume(2)
            with self.assertRaisesRegex(ValueError, "presupuesto"):
                budget.fetch(skin.API + "ISIC_0000000/", 6)
            self.assertEqual(budget.used, 7)

    def test_stream_truncation_is_not_success(self):
        class Response(io.BytesIO):
            headers = {"Content-Length": "5"}

        class Opener:
            def open(self, url, timeout):
                return Response(b"123")

        with patch("urllib.request.build_opener", return_value=Opener()):
            budget = skin.Budget(10)
            with self.assertRaisesRegex(ValueError, "incompleta"):
                budget.fetch(skin.API, 10)
            self.assertEqual(budget.used, 3)

    def test_rows_are_reproducible_stratified_and_preserve_diagnoses(self):
        csv = "image_id,melanoma,seborrheic_keratosis\n" + "\n".join(
            f"ISIC_{i:07},{int(i % 3 == 0)},{int(i % 3 == 1)}" for i in range(12))
        rows = skin.ordered_rows(csv, 12)
        self.assertEqual(rows, skin.ordered_rows(csv, 12))
        self.assertNotEqual(rows, skin.ordered_rows(csv, 13))
        self.assertEqual(len({r["sourceDiagnosis"] for r in rows[:3]}), 3)
        for bad in ("image_id,melanoma,seborrheic_keratosis\n../../x,0,0",
                    "image_id,melanoma,seborrheic_keratosis\nISIC_0000000,1,1"):
            with self.assertRaises(ValueError):
                skin.ordered_rows(bad, 1)
        with self.assertRaisesRegex(ValueError, "repite"):
            skin.ordered_rows(csv + "\nISIC_0000000,1,0", 1)

    def pairs(self):
        return [{"id": f"ISIC_{i:07}", "split": split, "license": "CC-0", "imageSha256": skin.digest(str(i).encode())}
                for i, split in enumerate(("train", "train", "validation", "validation", "test", "test"))]

    def test_cc0_license_split_and_hash_duplicates_are_enforced(self):
        self.assertEqual(skin.validate_pairs(self.pairs()), {"train": 2, "validation": 2, "test": 2})
        for key, value in (("id", "ISIC_0000000"), ("imageSha256", self.pairs()[0]["imageSha256"]),
                           ("license", "CC-BY-NC"), ("split", "other"), ("id", "../secret")):
            pairs = self.pairs()
            pairs[-1][key] = value
            with self.assertRaises(ValueError):
                skin.validate_pairs(pairs)
        with self.assertRaisesRegex(ValueError, "dos pares"):
            skin.validate_pairs(self.pairs()[:-1])
        for invalid in (None, {}, [None], [{"split": "test", "id": None}]):
            with self.assertRaises(ValueError):
                skin.validate_pairs(invalid)

    def test_letterbox_preserves_portrait_landscape_and_excludes_padding(self):
        for dimensions in ((80, 40), (40, 80), (41, 79), (79, 41)):
            photo = Image.new("RGB", dimensions, (255, 0, 0))
            mask = Image.new("L", dimensions, 255)
            image, target, valid = skin.letterbox(photo, mask, 64)
            w, h, x, y = skin.geometry(*dimensions, 64)
            self.assertEqual(tuple(image.shape), (3, 64, 64))
            self.assertEqual(int(valid.sum()), w * h)
            self.assertEqual(int(target.sum()), w * h)
            self.assertTrue(valid[y:y + h, x:x + w].all())
            self.assertTrue((target[~valid] == 0).all())
            self.assertEqual(float(image[0, y, x]), 1)
            self.assertEqual(float(image[1, y, x]), -1)
        for dimensions in ((0, 40), (6000, 6000), (False, 80)):
            with self.assertRaises(ValueError):
                skin.geometry(*dimensions, 64)

    def test_metrics_measure_segmentation_not_classification_and_no_empty_success(self):
        row = skin.segmentation_metrics([True, True, False, False], [True, False, True, False])
        self.assertEqual((row["tp"], row["fp"], row["fn"]), (1, 1, 1))
        self.assertAlmostEqual(row["iou"], 1 / 3)
        self.assertEqual(row["dice"], .5)
        self.assertEqual(row["precision"], .5)
        self.assertEqual(row["recall"], .5)
        empty = skin.segmentation_metrics([False], [True])
        self.assertIsNone(empty["precision"])
        self.assertEqual(empty["recall"], 0)
        self.assertEqual(skin.summarize([row, empty])["precisionDefinedImages"], 1)
        self.assertEqual(skin.summarize([row, empty])["pixels"]["recall"], 1 / 3)
        with self.assertRaises(ValueError):
            skin.segmentation_metrics([[True]], [True])

    def test_manifest_detects_tampering_and_count_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pairs = self.pairs()
            for item in pairs:
                for suffix, key in ((".jpg", "imageSha256"), ("_mask.png", "maskSha256")):
                    content = (item["id"] + suffix).encode()
                    (root / (item["id"] + suffix)).write_bytes(content)
                    item[key] = skin.digest(content)
            manifest = {"version": 1, "source": "ISIC-2017", "images": pairs,
                        "counts": {"train": 2, "validation": 2, "test": 2}}
            skin.write_json(root / "manifest.json", manifest)
            self.assertEqual(skin.load_manifest(root), manifest)
            (root / "ISIC_0000000.jpg").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "alterado"):
                skin.load_manifest(root)
            manifest["counts"]["test"] = 9
            skin.write_json(root / "manifest.json", manifest)
            with self.assertRaisesRegex(ValueError, "Conteos"):
                skin.load_manifest(root)

    def test_cli_rejects_unapproved_budgets_before_io(self):
        for args in (
            ["prepare", "--output", "unused", "--max-mb", "101"],
            ["train", "--data", "unused", "--output", "unused", "--minutes", "11"],
            ["train", "--data", "unused", "--output", "unused", "--minutes", "nan"],
            ["train", "--data", "unused", "--output", "unused", "--threads", "8"],
        ):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                skin.main(args)
            self.assertEqual(error.exception.code, 2)

    def test_prepare_pairs_and_resume_failure_preserve_cumulative_budget(self):
        resources = {}
        for split_index, (_, (csv_name, zip_name)) in enumerate(skin.PARTITIONS.items()):
            ids = [f"ISIC_{split_index * 10 + i:07}" for i in range(2)]
            resources[skin.SOURCE + csv_name] = (
                "image_id,melanoma,seborrheic_keratosis\n" + "\n".join(f"{key},0,0" for key in ids)).encode()
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as masks:
                for index, key in enumerate(ids):
                    image_bytes, mask_bytes = io.BytesIO(), io.BytesIO()
                    Image.new("RGB", (80, 40), (40 * (split_index * 2 + index), 50, 100)).save(image_bytes, format="JPEG")
                    mask = Image.new("L", (80, 40))
                    mask.paste(255, (20, 10, 60, 30))
                    mask.save(mask_bytes, format="PNG")
                    masks.writestr(key + "_segmentation.png", mask_bytes.getvalue())
                    url = "https://isic-archive.s3.amazonaws.com/images/" + key + ".jpg"
                    resources[url] = image_bytes.getvalue()
                    resources[skin.API + key + "/"] = json.dumps({
                        "isic_id": key, "public": True, "copyright_license": "CC-0",
                        "files": {"full": {"url": url, "size": len(image_bytes.getvalue())}},
                    }).encode()
            resources[skin.SOURCE + zip_name] = archive.getvalue()

        def fake_fetch(budget, url, maximum):
            content = resources[url]
            self.assertLessEqual(len(content), maximum)
            budget.consume(len(content))
            return content

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "data"
            args = ["prepare", "--output", str(output), "--train", "2", "--validation", "2", "--test", "2"]
            with patch.object(skin.Budget, "fetch", new=fake_fetch), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(skin.main(args), 0)
            manifest = skin.load_manifest(output)
            self.assertEqual(manifest["counts"], {"train": 2, "validation": 2, "test": 2})
            self.assertTrue(all(item["sourceDiagnosis"] == "nevus" for item in manifest["images"]))
            spent = manifest["downloadBytes"]
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(skin.main(args + ["--resume"]), 1)
            (output / "manifest.json").unlink()
            with patch.object(skin.Budget, "fetch", side_effect=ValueError("Network stopped")), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(skin.main(args + ["--resume"]), 1)
            audit = json.loads((output / "download-audit.json").read_text())
            self.assertEqual(audit["downloadBytes"], spent)
            self.assertFalse((output / "manifest.json").exists())

    def test_model_and_prediction_work_offline_with_original_coordinates(self):
        torch.set_num_threads(2)
        torch.manual_seed(1)
        with patch("urllib.request.urlopen", side_effect=AssertionError("No network")):
            model = skin.make_model()
            model.train()
            logits = model(torch.rand(2, 3, 64, 64))["out"]
            self.assertEqual(tuple(logits.shape), (2, 2, 64, 64))
            logits.square().mean().backward()
            self.assertIsNotNone(next(model.parameters()).grad)
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                checkpoint = root / "model.pt"
                torch.save({"architecture": skin.ARCHITECTURE, "state_dict": model.state_dict(), "size": 64,
                            "threshold": 0, "normalization": "rgb-div127.5-minus1"}, checkpoint)
                photo = root / "photo.png"
                Image.new("RGB", (81, 43), (70, 50, 40)).save(photo)
                output = root / "out"
                self.assertEqual(skin.main(["predict", "--model", str(checkpoint),
                                           "--image", str(photo), "--output", str(output)]), 0)
                with Image.open(output / "mask.png") as mask:
                    self.assertEqual(mask.size, (81, 43))
                    self.assertEqual(set(mask.getdata()), {255})
                result = json.loads((output / "prediction.json").read_text())
                self.assertEqual(result["foregroundBox"], {"x": 0, "y": 0, "width": 1, "height": 1})
                self.assertIsNone(result["category"])
                self.assertFalse(result["eligibleForClinicalUse"])
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(skin.main(["predict", "--model", str(checkpoint),
                                               "--image", str(photo), "--output", str(output)]), 1)


if __name__ == "__main__":
    unittest.main()
