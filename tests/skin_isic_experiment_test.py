import contextlib
import hashlib
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
            ["train", "--data", "unused", "--output", "unused", "--minutes", "61", "--budget-ledger", "unused"],
            ["train", "--data", "unused", "--output", "unused", "--minutes", "nan"],
            ["train", "--data", "unused", "--output", "unused", "--learning-rate", "nan"],
            ["train", "--data", "unused", "--output", "unused", "--threads", "8"],
        ):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                skin.main(args)
            self.assertEqual(error.exception.code, 2)

    def test_memi_palette_indices_are_not_grayscale_thresholds(self):
        palette = Image.new("P", (2, 2))
        palette.putdata([0, 1, 1, 0])
        palette.putpalette([0, 0, 0, 128, 128, 0] + [0] * 762)
        self.assertEqual(set(palette.convert("L").getdata()), {0, 113})
        converted = skin.canonical_memi_mask(palette)
        self.assertEqual(np.array(converted).tolist(), [[0, 255], [255, 0]])
        for array in (np.array([[0, 2]], dtype="uint8"), np.zeros((2, 2), dtype="uint8"),
                  np.array([[0, 1, 2, 3, 4, 5]], dtype="uint8")):
            self.assertRaisesRegex(ValueError, "etiquetas originales", skin.canonical_memi_mask, Image.fromarray(array))

    def test_memi_views_remain_grouped_and_cannot_leak(self):
        groups = [str(i) for i in range(63)]
        splits = skin.group_splits(groups, 20)
        self.assertEqual(splits, skin.group_splits(groups * 2, 20))
        self.assertNotEqual(splits, skin.group_splits(groups, 21))
        self.assertEqual(len([s for s in splits.values() if s == "test"]), 10)
        images = [{"id": f"MEMI_{group}_{view}", "group": group, "split": splits[group],
                   "license": "CC-BY-4.0", "imageSha256": skin.digest(f"{group}_{view}".encode())}
                  for group in groups for view in ("F", "L", "R")]
        self.assertEqual(sum(skin.validate_pairs(images, "MEMI-DS").values()), 189)
        images[-1]["split"] = next(s for s in ("train", "test", "validation") if s != images[-1]["split"])
        with self.assertRaisesRegex(ValueError, "Fuga"):
            skin.validate_pairs(images, "MEMI-DS")
        with self.assertRaisesRegex(ValueError, "diez grupos"):
            skin.group_splits(["1", "2"], 3)

    def test_memi_file_pairs_verify_names_sizes_checksums_and_urls(self):
        files = [{"name": "10_L." + extension, "size": 20, "computed_md5": "a" * 32,
              "download_url": "https://ndownloader.figshare.com/files/12"} for extension in ("jpg", "png")]
        self.assertEqual(set(skin.memi_pairs(files)["10_L"]), {"jpg", "png"})
        with self.assertRaisesRegex(ValueError, "mascara"):
            skin.memi_pairs(files[:1])
        for key, value in (("name", "../x.jpg"), ("size", -1), ("computed_md5", "bad"),
                       ("download_url", "https://example.com/image.jpg")):
            invalid = [dict(file) for file in files]
            invalid[0][key] = value
            self.assertRaises(ValueError, skin.memi_pairs, invalid)

    def test_training_reservation_is_cumulative_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "budget.json"
            skin.reserve_training_budget(path, 20)
            skin.reserve_training_budget(path, 30)
            self.assertEqual(json.loads(path.read_text())["reservedMinutes"], 50)
            self.assertRaisesRegex(ValueError, "agoto", skin.reserve_training_budget, path, 11)
            self.assertFalse(path.with_suffix(".json.lock").exists())
            self.assertEqual(json.loads(path.read_text())["reservedMinutes"], 50)
            path.with_suffix(".json.lock").touch()
            self.assertRaises(FileExistsError, skin.reserve_training_budget, path, 1)
            path.with_suffix(".json.lock").unlink()
            self.assertRaises(ValueError, skin.reserve_training_budget, path, float("nan"))

    def test_intervals_resample_groups_not_individual_views(self):
        rows = [{"id": "a_L", "group": "a", "tp": 7, "fp": 3, "fn": 3},
                {"id": "a_R", "group": "a", "tp": 7, "fp": 3, "fn": 3},
                {"id": "b_L", "group": "b", "tp": 1, "fp": 9, "fn": 9}]
        intervals = skin.grouped_intervals(rows)
        self.assertEqual(intervals["groups"], 2)
        self.assertEqual(intervals["precision95"], [.1, .7])
        self.assertEqual(intervals["recall95"], [.1, .7])
        self.assertEqual(intervals, skin.grouped_intervals(rows))
        self.assertIsNone(skin.grouped_intervals(rows[:2])["precision95"])

    def test_components_localize_all_regions_without_hiding_tiny_predictions(self):
        mask = np.array([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype="uint8")
        probabilities = np.array([[.8, 0, 0, 0], [0, .6, 0, 0], [0, 0, 0, .9]])
        boxes = skin.component_boxes(mask, probabilities)
        self.assertEqual(len(boxes), 2)
        self.assertEqual(boxes[0]["x"], 0)
        self.assertEqual(boxes[0]["width"], .5)
        self.assertEqual(boxes[0]["height"], 2 / 3)
        self.assertAlmostEqual(boxes[0]["score"], .7)
        self.assertEqual(boxes[1]["x"], .75)
        self.assertEqual(boxes[1]["width"], .25)
        self.assertEqual(boxes[1]["height"], 1 / 3)
        self.assertEqual(skin.component_boxes(np.zeros((3, 4))), [])
        self.assertRaises(ValueError, skin.component_boxes, np.zeros(3))
        self.assertRaises(ValueError, skin.component_boxes, mask, np.ones((1, 1)))

    def test_training_crops_preserve_labels_and_original_bounds(self):
        mask = Image.new("L", (800, 1200))
        mask.paste(255, (700, 1000, 800, 1200))
        boxes = skin.training_crop_boxes(mask, 10)
        self.assertEqual(boxes, skin.training_crop_boxes(mask, 10))
        self.assertNotEqual(boxes[1], skin.training_crop_boxes(mask, 11)[1])
        self.assertEqual(mask.crop(boxes[0]).getextrema(), (0, 255))
        for x, y, right, bottom in boxes:
            self.assertTrue(0 <= x < right <= 800)
            self.assertTrue(0 <= y < bottom <= 1200)
        self.assertRaises(ValueError, skin.training_crop_boxes, Image.new("L", (20, 20)), 1)

    def test_training_cache_is_lossless_and_compact(self):
        image = Image.fromarray(np.arange(256, dtype="uint8").reshape(16, 16)).convert("RGB")
        mask = Image.new("L", image.size, 255)
        expected, target, valid = skin.letterbox(image, mask, 64)
        _, cached, cached_target, cached_valid = skin.cached_entry("fixture", image, mask, 64)
        self.assertEqual(cached.dtype, torch.uint8)
        self.assertTrue(torch.equal(cached.float() / 127.5 - 1, expected))
        self.assertTrue(torch.equal(cached_target, target))
        self.assertTrue(torch.equal(cached_valid, valid))
        self.assertEqual(cached.nelement() * cached.element_size() * 4, expected.nelement() * expected.element_size())

    def test_weak_foreground_never_imports_heldout_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identifier = "MEMI_1_F"
            photo = io.BytesIO()
            Image.new("RGB", (80, 48), (90, 60, 50)).save(photo, format="JPEG")
            mask = Image.new("P", (80, 48))
            mask.paste(1, (10, 10, 30, 30))
            mask.paste(2, (40, 10, 60, 30))
            raw_mask = io.BytesIO()
            mask.save(raw_mask, format="PNG")
            (root / (identifier + ".jpg")).write_bytes(photo.getvalue())
            (root / (identifier + "_source.png")).write_bytes(raw_mask.getvalue())
            metadata = {"files": [
                {"name": "1_F.jpg", "size": len(photo.getvalue()), "download_url": "https://ndownloader.figshare.com/files/1",
                 "computed_md5": hashlib.md5(photo.getvalue()).hexdigest()},
                {"name": "1_F.png", "size": len(raw_mask.getvalue()), "download_url": "https://ndownloader.figshare.com/files/2",
                 "computed_md5": hashlib.md5(raw_mask.getvalue()).hexdigest()},
            ]}
            skin.write_json(root / "source-metadata.json", metadata)
            manifest = {
                "source": "MEMI-DS", "sourceMetadataSha256": skin.digest((root / "source-metadata.json").read_bytes()),
                "images": [{"group": "1", "split": "train"}, {"group": "2", "split": "test"}],
                "excluded": [{"id": "MEMI_1_F"}, {"id": "MEMI_2_F"}],
            }
            entries, provenance = skin.weak_memi_entries(root, manifest, 64)
            self.assertEqual([entry[0] for entry in entries], ["MEMI_1_F"])
            self.assertEqual(provenance[0]["weight"], .15)
            self.assertEqual(provenance[0]["quality"], "weak-training-only-not-clinical-reference")
            self.assertEqual(int(entries[0][2].sum()), 512)
            (root / (identifier + ".jpg")).write_bytes(b"tampered")
            self.assertRaisesRegex(ValueError, "editor", skin.weak_memi_entries, root, manifest, 64)

    def test_memi_preparation_resumes_audited_downloads_and_excludes_ambiguous_masks(self):
        resources, files = {}, []
        names = [f"{group}_{view}" for group in range(12) for view in ("L", "R")] + ["0_F"]
        for index, name in enumerate(names):
            image = Image.new("RGB", (80, 48), (index * 9, 70, 50))
            mask = Image.new("P", image.size)
            mask.putpalette([0, 0, 0, 128, 128, 0, 128, 0, 0] + [0] * 759)
            mask.paste(1, (20, 10, 55, 35))
            if name == "0_F":
                mask.paste(2, (5, 5, 10, 10))
            for extension, content_image, format_name in (("jpg", image, "JPEG"), ("png", mask, "PNG")):
                stream = io.BytesIO()
                content_image.save(stream, format=format_name)
                content = stream.getvalue()
                url = "https://ndownloader.figshare.com/files/" + str(len(files) + 1)
                resources[url] = content
                files.append({"name": name + "." + extension, "size": len(content),
                              "computed_md5": hashlib.md5(content).hexdigest(), "download_url": url})
        resources[skin.MEMI_API] = json.dumps({
            "version": 1, "license": {"url": "https://creativecommons.org/licenses/by/4.0/"},
            "files": files,
        }).encode()
        calls = []

        def fake_fetch(budget, url, maximum):
            calls.append(url)
            if len(calls) == 7:
                raise OSError("Temporary interruption")
            content = resources[url]
            self.assertLessEqual(len(content), maximum)
            budget.consume(len(content))
            return content

        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            args = ["prepare-memi", "--output", str(data), "--max-mb", "1"]
            with patch.object(skin.Budget, "fetch", new=fake_fetch), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(skin.main(args), 1)
            spent = json.loads((data / "download-audit.json").read_text())["downloadBytes"]
            self.assertGreater(spent, 0)
            with patch.object(skin.Budget, "fetch", new=fake_fetch), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(skin.main(args + ["--resume"]), 0)
            manifest = skin.load_manifest(data)
            self.assertEqual(len(manifest["images"]), 24)
            self.assertEqual(len(manifest["excluded"]), 1)
            self.assertEqual(manifest["excluded"][0]["id"], "MEMI_0_F")
            self.assertEqual(manifest["downloadBytes"], sum(map(len, resources.values())))
            self.assertEqual(calls.count(skin.MEMI_API), 1)
            self.assertEqual(set(Image.open(data / "MEMI_1_L_mask.png").getdata()), {0, 255})

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

    def test_training_can_leave_test_untouched_until_frozen_evaluation(self):
        torch.set_num_threads(2)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            pairs = self.pairs()
            for index, item in enumerate(pairs):
                image_path = data / (item["id"] + ".jpg")
                mask_path = data / (item["id"] + "_mask.png")
                Image.new("RGB", (80, 48), (index * 30, 80, 70)).save(image_path)
                mask = Image.new("L", (80, 48))
                mask.paste(255, (20, 10, 55, 35))
                mask.save(mask_path)
                item["imageSha256"] = skin.digest(image_path.read_bytes())
                item["maskSha256"] = skin.digest(mask_path.read_bytes())
            skin.write_json(data / "manifest.json", {
                "version": 1, "source": "ISIC-2017", "images": pairs,
                "counts": {"train": 2, "validation": 2, "test": 2},
                "independence": "Synthetic fixtures only",
            })
            run, evaluation = root / "run", root / "evaluation"
            with patch.object(skin, "available_memory_bytes", return_value=2 * 1024 ** 3), contextlib.redirect_stdout(io.StringIO()):
                code = skin.main(["train", "--data", str(data), "--output", str(run),
                                  "--minutes", "1", "--epochs", "1", "--size", "64", "--batch", "2",
                                  "--validation-only", "--training-crops"])
            self.assertEqual(code, 0)
            report = json.loads((run / "report.json").read_text())
            self.assertFalse(report["testEvaluated"])
            self.assertIsNone(report["test"])
            self.assertIsNone(report["allForegroundBaselineTest"])
            self.assertEqual(len(report["trainingCrops"]), 4)
            self.assertEqual(report["cachedImageEncoding"], "uint8-lossless; normalized per batch")
            with contextlib.redirect_stdout(io.StringIO()), patch.object(Image, "open", wraps=Image.open) as opened:
                self.assertEqual(skin.main(["export-web", "--model", str(run / "model.pt"),
                                           "--data", str(data), "--output", str(root / "web")]), 0)
            self.assertEqual({Path(call.args[0]).stem for call in opened.call_args_list},
                             {item["id"] for item in pairs if item["split"] == "validation"})
            web = json.loads((root / "web" / "model.json").read_text())
            self.assertEqual(len(web["cases"]), 4)
            self.assertTrue(web["browserQualificationRequired"])
            checkpoint_hash = skin.digest((run / "model.pt").read_bytes())
            with contextlib.redirect_stdout(io.StringIO()):
                code = skin.main(["evaluate", "--data", str(data), "--model", str(run / "model.pt"),
                                  "--output", str(evaluation)])
            self.assertEqual(code, 0)
            result = json.loads((evaluation / "evaluation.json").read_text())
            self.assertEqual(result["test"]["images"], 2)
            self.assertEqual(result["modelSha256"], checkpoint_hash)
            self.assertEqual(result["threshold"], report["threshold"])
            self.assertFalse(result["thresholdChanged"])
            self.assertFalse(result["eligibleForClinicalUse"])
            blocked = root / "memory-blocked"
            with patch.object(skin, "available_memory_bytes", return_value=0), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = skin.main(["train", "--data", str(data), "--output", str(blocked),
                                  "--minutes", "1", "--epochs", "1", "--size", "64", "--batch", "2",
                                  "--validation-only"])
            self.assertEqual(code, 1)
            self.assertFalse((blocked / "model.pt").exists())

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

    def test_web_export_preserves_probabilities_masks_and_checkpoint(self):
        torch.set_num_threads(2)
        torch.manual_seed(7)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / "model.pt"
            model = skin.make_model().eval()
            torch.save({"architecture": skin.ARCHITECTURE, "state_dict": model.state_dict(),
                        "size": 64, "threshold": .5, "normalization": "rgb-div127.5-minus1",
                        "source": "MEMI-DS", "category": "melasma"}, checkpoint)
            original_hash = skin.digest(checkpoint.read_bytes())
            output = root / "web"
            with contextlib.redirect_stdout(io.StringIO()), patch("urllib.request.urlopen", side_effect=AssertionError("No network")):
                self.assertEqual(skin.main(["export-web", "--model", str(checkpoint),
                                            "--output", str(output)]), 0)
            contract = json.loads((output / "model.json").read_text())
            self.assertFalse(contract["eligibleForClinicalUse"])
            self.assertEqual(contract["sourceCheckpointSha256"], original_hash)
            self.assertEqual(skin.digest(checkpoint.read_bytes()), original_hash)
            self.assertEqual(contract["inputShape"], [1, 3, 64, 64])
            self.assertEqual(contract["outputShape"], [1, 1, 64, 64])
            self.assertEqual(contract["model"]["sha256"], skin.digest((output / "model.onnx").read_bytes()))
            self.assertEqual(len(contract["cases"]), 2)
            for case in contract["cases"]:
                for key in ("input", "expected"):
                    self.assertEqual(case[key]["sha256"], skin.digest((output / case[key]["file"]).read_bytes()))
                image = np.frombuffer((output / case["input"]["file"]).read_bytes(), dtype="<f4").copy()
                expected = np.frombuffer((output / case["expected"]["file"]).read_bytes(), dtype="<f4")
                with torch.inference_mode():
                    actual = model(torch.from_numpy(image.reshape(contract["inputShape"])))["out"].softmax(1)[:, 1:2]
                np.testing.assert_allclose(actual.numpy().ravel(), expected, atol=1e-7, rtol=0)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(skin.main(["export-web", "--model", str(checkpoint),
                                            "--output", str(output)]), 1)


if __name__ == "__main__":
    unittest.main()
