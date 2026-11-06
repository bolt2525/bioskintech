"""Ensayos locales de segmentacion ISIC CC0 y MEMI CC BY. No diagnostico."""

import argparse
import csv
import hashlib
import io
import json
import math
import random
import re
import sys
import time
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

SOURCE = "https://isic-archive.s3.amazonaws.com/challenges/2017/"
API = "https://api.isic-archive.com/api/v2/images/"
PARTITIONS = {
    "train": ("ISIC-2017_Training_Part3_GroundTruth.csv", "ISIC-2017_Training_Part1_GroundTruth.zip"),
    "validation": ("ISIC-2017_Validation_Part3_GroundTruth.csv", "ISIC-2017_Validation_Part1_GroundTruth.zip"),
    "test": ("ISIC-2017_Test_v2_Part3_GroundTruth.csv", "ISIC-2017_Test_v2_Part1_GroundTruth.zip"),
}
ARCHITECTURE = "torchvision-lraspp-mobilenet-v3-large-scratch-v1"
CATEGORIES = ("acne", "spot", "nevus", "scar", "melasma", "pore", "fine-wrinkle", "coarse-wrinkle")
MEMI_API = "https://api.figshare.com/v2/articles/29209229/versions/1"


class OversizedRemoteFile(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


class Budget:
    def __init__(self, maximum, origins=None):
        self.maximum = maximum
        self.used = 0
        self.origins = origins or ("https://api.isic-archive.com/api/v2/images/",
                                  "https://isic-archive.s3.amazonaws.com/")

    def consume(self, amount):
        if amount < 0 or self.used + amount > self.maximum:
            raise ValueError("Tope de descarga alcanzado; no se completo la muestra.")
        self.used += amount

    def fetch(self, url, maximum):
        allowed = self.origins
        if not url.startswith(allowed):
            raise ValueError("Origen de descarga no permitido.")
        limit = min(maximum, self.maximum - self.used)
        if limit <= 0:
            raise ValueError("Tope de descarga alcanzado.")
        # No se siguen redirecciones a hosts ajenos al archivo publico.
        class Redirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                if not newurl.startswith(allowed):
                    raise ValueError("Redireccion fuera de los origenes autorizados rechazada.")
                return super().redirect_request(req, fp, code, msg, headers, newurl)
        opener = urllib.request.build_opener(Redirect())
        with opener.open(url, timeout=45) as response:
            length = response.headers.get("Content-Length")
            if length is not None:
                if int(length) < 0:
                    raise ValueError("Tamano remoto invalido.")
                if int(length) > maximum:
                    raise OversizedRemoteFile("El archivo supera el limite individual.")
                if int(length) > limit:
                    raise ValueError("El archivo excede el presupuesto restante.")
            chunks, received = [], 0
            while received < limit:
                chunk = response.read(min(65536, limit - received))
                if not chunk:
                    break
                self.consume(len(chunk))
                chunks.append(chunk)
                received += len(chunk)
            if (length is None and received == limit) or (length is not None and received != int(length)):
                raise ValueError("Respuesta incompleta o de tamano no verificable dentro del tope.")
            return b"".join(chunks)


def memi_pairs(files):
    pairs = {}
    for item in files:
        match = re.fullmatch(r"(\d+)_[FLR]\.(jpg|png)", item.get("name", ""))
        if match is None:
            raise ValueError("Nombre de archivo MEMI no reconocido.")
        name, extension = item["name"].rsplit(".", 1)
        if extension in pairs.setdefault(name, {}):
            raise ValueError("Archivo MEMI repetido.")
        if (type(item.get("size")) is not int or not 0 < item["size"] <= 10_000_000
                or not re.fullmatch(r"[a-f0-9]{32}", item.get("computed_md5", ""))
                or not re.fullmatch(r"https://ndownloader\.figshare\.com/files/\d+", item.get("download_url", ""))):
            raise ValueError("Archivo MEMI sin integridad, tamano u origen verificable.")
        pairs[name][extension] = item
    if not pairs or any(set(pair) != {"jpg", "png"} for pair in pairs.values()):
        raise ValueError("Cada fotografia MEMI necesita su mascara con el mismo nombre.")
    return pairs


def group_splits(groups, seed):
    groups = sorted(set(groups))
    if len(groups) < 10:
        raise ValueError("Se requieren al menos diez grupos.")
    random.Random(seed).shuffle(groups)
    heldout = max(2, round(len(groups) * .16))
    return {group: "test" if index < heldout else "validation" if index < heldout * 2 else "train"
            for index, group in enumerate(groups)}


def canonical_memi_mask(mask):
    import numpy as np
    from PIL import Image
    values = np.asarray(mask)
    if values.ndim != 2 or values.dtype != np.uint8 or np.flatnonzero(np.bincount(values.ravel(), minlength=256)).tolist() != [0, 1]:
        raise ValueError("MEMI requiere etiquetas originales 0/1; no umbralizar colores de paleta.")
    return Image.fromarray((values * 255).astype("uint8"))


def prepare_memi(args):
    import numpy as np
    from PIL import Image
    root = Path(args.output)
    if args.resume:
        if (root / "manifest.json").exists():
            raise ValueError("La muestra ya esta completa.")
        prior = json.loads((root / "download-audit.json").read_text(encoding="utf-8"))
        if prior["downloadLimitBytes"] != args.max_mb * 1_000_000:
            raise ValueError("Reanudar requiere el mismo presupuesto.")
    else:
        root.mkdir(parents=True, exist_ok=False)
        prior = {"downloadBytes": 0}
    origins = ("https://api.figshare.com/v2/articles/29209229/",
               "https://ndownloader.figshare.com/files/",
               "https://s3-eu-west-1.amazonaws.com/pfigshare-u-files/")
    budget = Budget(args.max_mb * 1_000_000, origins)
    budget.consume(prior["downloadBytes"])
    images, excluded = [], []
    try:
        metadata_path = root / "source-metadata.json"
        metadata_bytes = metadata_path.read_bytes() if args.resume and metadata_path.exists() else budget.fetch(MEMI_API, 1_000_000)
        if len(metadata_bytes) > 1_000_000:
            raise ValueError("Metadatos MEMI demasiado grandes.")
        metadata = json.loads(metadata_bytes)
        if metadata.get("version") != 1 or metadata.get("license", {}).get("url") != "https://creativecommons.org/licenses/by/4.0/":
            raise ValueError("Version o licencia MEMI modificada; revisar antes de usar.")
        pairs = memi_pairs(metadata["files"])
        remaining_bytes = sum(item["size"] for name, pair in pairs.items() for extension, item in pair.items()
                              if not (args.resume and (root / ("MEMI_" + name + (".jpg" if extension == "jpg" else "_source.png"))).exists()))
        if remaining_bytes > budget.maximum - budget.used:
            raise ValueError("El conjunto completo excede el presupuesto autorizado.")
        splits = group_splits([name.split("_")[0] for name in pairs], args.seed)
        (root / "source-metadata.json").write_bytes(metadata_bytes)
        for name, pair in sorted(pairs.items()):
            content = {}
            for extension, item in pair.items():
                cache = root / ("MEMI_" + name + (".jpg" if extension == "jpg" else "_source.png"))
                raw = cache.read_bytes() if args.resume and cache.exists() else budget.fetch(item["download_url"], 10_000_000)
                if len(raw) != item["size"] or hashlib.md5(raw, usedforsecurity=False).hexdigest() != item["computed_md5"]:
                    raise ValueError("Archivo MEMI no coincide con el MD5/tamano del editor.")
                content[extension] = raw
                cache.write_bytes(raw)
            with Image.open(io.BytesIO(content["jpg"])) as photo, Image.open(io.BytesIO(content["png"])) as mask:
                geometry(*photo.size, 256)
                if photo.size != mask.size:
                    raise ValueError("Mascara MEMI no corresponde a las dimensiones de la foto.")
                values = np.asarray(mask)
                labels = np.flatnonzero(np.bincount(values.ravel(), minlength=256)).tolist() if values.dtype == np.uint8 else []
                if values.ndim != 2 or labels != [0, 1]:
                    excluded.append({"id": "MEMI_" + name, "reason": "Ambiguous-label-schema", "labels": labels})
                    print(f"MEMI {name}: excluida, etiquetas sin esquema documentado {labels}", flush=True)
                    continue
                canonical = canonical_memi_mask(mask)
                width, height = photo.size
            identifier, group = "MEMI_" + name, name.split("_")[0]
            (root / (identifier + ".jpg")).write_bytes(content["jpg"])
            canonical.save(root / (identifier + "_mask.png"))
            images.append({"id": identifier, "group": group, "split": splits[group],
                           "license": "CC-BY-4.0", "imageSha256": digest(content["jpg"]),
                           "maskSha256": digest((root / (identifier + "_mask.png")).read_bytes()),
                           "sourceMaskSha256": digest(content["png"]), "width": width, "height": height,
                           "sourceDiagnosis": "melasma"})
            print(f"MEMI: {len(images)}/{len(pairs)}", flush=True)
        counts = validate_pairs(images, "MEMI-DS")
        write_json(root / "manifest.json", {
            "version": 1, "source": "MEMI-DS", "seed": args.seed, "images": images, "counts": counts,
            "category": "melasma", "downloadBytes": budget.used, "downloadLimitBytes": budget.maximum,
            "excluded": excluded,
            "sourceUrl": "https://doi.org/10.6084/m9.figshare.29209229.v1",
            "sourceMetadataSha256": digest(metadata_bytes),
            "attribution": "Zhenwei Zhai, MEMI-DS, 2025, CC BY 4.0. Mascaras convertidas de indices 0/1 a 0/255; particion local.",
            "licenseSource": metadata["license"]["url"],
            "independence": "Prefijos numericos completos en una sola particion, IDs y SHA256 disjuntos. Identidad de paciente por prefijo no confirmada por el editor; sin auditoria de duplicados perceptuales.",
            "annotationLimits": "Solo mascaras binarias 0/1 de los 131 pares publicos; mascaras multietiqueta excluidas por esquema no documentado. No asumir 716 imagenes del articulo ni protocolo experto no documentado. Sin negativos sanos independientes ni validacion diagnostica.",
        })
    finally:
        write_json(root / "download-audit.json", {"downloadBytes": budget.used,
                   "downloadLimitBytes": budget.maximum, "completedPairs": len(images), "excluded": excluded})


def ordered_rows(text, seed):
    groups = {}
    for row in csv.DictReader(text.splitlines()):
        identifier = row.get("image_id", "")
        if not re.fullmatch(r"ISIC_\d{7}", identifier):
            raise ValueError("CSV ISIC con identificador invalido.")
        a, b = float(row["melanoma"]), float(row["seborrheic_keratosis"])
        if (a, b) not in ((0, 0), (1, 0), (0, 1)):
            raise ValueError("Etiquetas ISIC 2017 no reconocidas.")
        row["sourceDiagnosis"] = "melanoma" if a else "seborrheic-keratosis" if b else "nevus"
        groups.setdefault(row["sourceDiagnosis"], []).append(row)
    if len({r["image_id"] for rows in groups.values() for r in rows}) != sum(map(len, groups.values())):
        raise ValueError("El CSV repite imagenes.")
    rng = random.Random(seed)
    for rows in groups.values():
        rng.shuffle(rows)
    result = []
    while any(groups.values()):
        for name in sorted(groups):
            if groups[name]:
                result.append(groups[name].pop())
    return result


def validate_pairs(images, source="ISIC-2017"):
    if not isinstance(images, list):
        raise ValueError("Se requiere una lista de pares.")
    ids, hashes, groups = set(), set(), {}
    counts = Counter()
    if source not in ("ISIC-2017", "MEMI-DS"):
        raise ValueError("Origen de anotaciones desconocido.")
    pattern = r"ISIC_\d{7}" if source == "ISIC-2017" else r"MEMI_(\d+)_[FLR]"
    license_name = "CC-0" if source == "ISIC-2017" else "CC-BY-4.0"
    for item in images:
        if (not isinstance(item, dict) or not isinstance(item.get("split"), str) or item["split"] not in PARTITIONS
                or not isinstance(item.get("id"), str) or not re.fullmatch(pattern, item["id"])
                or not isinstance(item.get("imageSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", item["imageSha256"])):
            raise ValueError("Particion o identificador invalido.")
        if item.get("license") != license_name:
            raise ValueError("Licencia incompatible con el origen declarado.")
        if item["id"] in ids or item["imageSha256"] in hashes:
            raise ValueError("Imagen repetida entre particiones o dentro de ellas.")
        ids.add(item["id"])
        hashes.add(item["imageSha256"])
        counts[item["split"]] += 1
        if source == "MEMI-DS":
            group = re.fullmatch(pattern, item["id"])[1]
            if item.get("group") != group or (group in groups and groups[group] != item["split"]):
                raise ValueError("Fuga de grupo MEMI entre particiones.")
            groups[group] = item["split"]
    if any(counts[name] < 2 for name in PARTITIONS):
        raise ValueError("Se requieren al menos dos pares en cada particion.")
    return dict(counts)


def prepare(args):
    from PIL import Image
    output = Path(args.output)
    if args.resume:
        if (output / "manifest.json").exists():
            raise ValueError("La muestra ya esta completa; no se sobrescribe.")
        prior = json.loads((output / "download-audit.json").read_text(encoding="utf-8"))
        if prior["downloadLimitBytes"] != args.max_mb * 1_000_000:
            raise ValueError("Reanudar requiere el mismo tope total, no un presupuesto adicional.")
    else:
        output.mkdir(parents=True, exist_ok=False)
        prior = {"downloadBytes": 0}
    budget = Budget(args.max_mb * 1_000_000)
    budget.consume(prior["downloadBytes"])
    images, sources, skipped, warnings = [], [], Counter(), Counter()
    try:
        for index, (split, (csv_name, zip_name)) in enumerate(PARTITIONS.items()):
            def cached(name, limit):
                path = output / name
                if args.resume and path.exists():
                    if path.stat().st_size > limit:
                        raise ValueError("Cache excede el limite individual.")
                    return path.read_bytes()
                content = budget.fetch(SOURCE + name, limit)
                path.write_bytes(content)
                return content
            csv_data = cached(csv_name, 200_000)
            mask_data = cached(zip_name, 25_000_000)
            sources.append({"split": split, "labelsUrl": SOURCE + csv_name, "labelsSha256": digest(csv_data),
                            "masksUrl": SOURCE + zip_name, "masksSha256": digest(mask_data), "license": "CC0"})
            with zipfile.ZipFile(io.BytesIO(mask_data)) as masks:
                names = {Path(info.filename).name.lower(): info for info in masks.infolist()}
                rows = ordered_rows(csv_data.decode("utf-8-sig"), args.seed + index)
                count = 0
                for row in rows:
                    if count >= getattr(args, split):
                        break
                    identifier = row["image_id"]
                    mask_info = names.get((identifier + "_segmentation.png").lower())
                    if mask_info is None:
                        raise ValueError("Falta una mascara oficial para " + identifier)
                    if mask_info.file_size > 20_000_000:
                        raise ValueError("Mascara descomprimida demasiado grande.")
                    metadata = json.loads(budget.fetch(API + identifier + "/", 100_000))
                    if metadata.get("isic_id") != identifier or metadata.get("public") is not True:
                        raise ValueError("Respuesta ISIC inesperada.")
                    if metadata.get("copyright_license") != "CC-0":
                        skipped["license-not-CC0"] += 1
                        continue
                    full = metadata["files"]["full"]
                    if not isinstance(full["size"], int) or not 0 < full["size"] <= 1_000_000:
                        skipped["image-over-1MB"] += 1
                        continue
                    image_path = output / (identifier + ".jpg")
                    if args.resume and image_path.exists():
                        if image_path.stat().st_size > 1_000_000:
                            raise ValueError("Imagen en cache demasiado grande.")
                        image_bytes = image_path.read_bytes()
                    else:
                        try:
                            image_bytes = budget.fetch(full["url"], 1_000_000)
                        except OversizedRemoteFile:
                            skipped["served-image-over-1MB"] += 1
                            continue
                    if len(image_bytes) != full["size"]:
                        warnings["api-size-differs-from-served-file"] += 1
                    mask_bytes = masks.read(mask_info)
                    with Image.open(io.BytesIO(image_bytes)) as photo, Image.open(io.BytesIO(mask_bytes)) as mask:
                        if photo.size != mask.size:
                            skipped["mask-dimensions-differ"] += 1
                            continue
                        geometry(*photo.size, 160)
                        values = set(mask.convert("L").getdata())
                        if values != {0, 255}:
                            raise ValueError("Mascara oficial no binaria o sin lesion/fondo.")
                        width, height = photo.size
                    (output / (identifier + ".jpg")).write_bytes(image_bytes)
                    (output / (identifier + "_mask.png")).write_bytes(mask_bytes)
                    images.append({"id": identifier, "split": split, "license": "CC-0",
                                   "attribution": metadata.get("attribution", ""), "imageUrl": full["url"],
                                   "imageSha256": digest(image_bytes), "maskSha256": digest(mask_bytes),
                                   "declaredImageBytes": full["size"], "servedImageBytes": len(image_bytes),
                                   "width": width, "height": height, "sourceDiagnosis": row["sourceDiagnosis"]})
                    count += 1
                    print(f"{split}: {count}/{getattr(args, split)}", flush=True)
                if count != getattr(args, split):
                    raise ValueError("No hay suficientes pares CC0 dentro del limite individual.")
        counts = validate_pairs(images)
        write_json(output / "manifest.json", {
            "version": 1, "source": "ISIC-2017", "seed": args.seed, "images": images, "counts": counts,
            "sources": sources, "downloadBytes": budget.used, "downloadLimitBytes": budget.maximum,
            "skipped": dict(skipped), "warnings": dict(warnings),
            "sampling": "Alterna diagnosticos y baraja con semilla; no prevalencia real.",
            "independence": "Splits oficiales, IDs y SHA256 disjuntos; sin grupos de paciente/lesion verificados.",
            "licenseSource": "https://challenge.isic-archive.com/data/",
            "annotationSource": "https://challenge.isic-archive.com/landing/2017/42/",
        })
    finally:
        write_json(output / "download-audit.json", {"downloadBytes": budget.used,
                   "downloadLimitBytes": budget.maximum, "completedPairs": len(images),
                   "skipped": dict(skipped), "warnings": dict(warnings)})


def geometry(width, height, size):
    if (any(type(value) is not int or value < 1 for value in (width, height, size))
            or width * height > 25_000_000 or size > 512):
        raise ValueError("Dimensiones invalidas o imagen mayor de 25 megapixeles.")
    scale = size / max(width, height)
    w, h = max(1, round(width * scale)), max(1, round(height * scale))
    return w, h, (size - w) // 2, (size - h) // 2


def letterbox(photo, mask, size):
    import numpy as np
    import torch
    from PIL import Image, ImageOps
    w, h, x, y = geometry(*photo.size, size)
    photo = photo.convert("RGB").resize((w, h), Image.Resampling.BILINEAR)
    photo = ImageOps.expand(photo, (x, y, size - w - x, size - h - y))
    image = torch.from_numpy(np.array(photo).copy()).permute(2, 0, 1).float() / 127.5 - 1
    valid = torch.zeros((size, size), dtype=torch.bool)
    valid[y:y + h, x:x + w] = True
    target = torch.zeros((size, size), dtype=torch.uint8)
    if mask is not None:
        resized = mask.convert("L").resize((w, h), Image.Resampling.NEAREST)
        target[y:y + h, x:x + w] = torch.from_numpy((np.array(resized) > 127).astype("uint8"))
    return image, target, valid


def segmentation_metrics(prediction, truth):
    import numpy as np
    p, t = np.asarray(prediction, dtype=bool), np.asarray(truth, dtype=bool)
    if p.shape != t.shape or not p.size:
        raise ValueError("Prediccion y mascara deben compartir dimensiones no vacias.")
    tp, fp, fn = int((p & t).sum()), int((p & ~t).sum()), int((~p & t).sum())
    return {"tp": tp, "fp": fp, "fn": fn,
            "iou": tp / (tp + fp + fn) if tp + fp + fn else None,
            "dice": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
            "precision": tp / (tp + fp) if tp + fp else None,
            "recall": tp / (tp + fn) if tp + fn else None}


def summarize(rows):
    result = {"images": len(rows)}
    for name in ("iou", "dice", "precision", "recall"):
        values = [row[name] for row in rows if row[name] is not None]
        result["macro" + name.capitalize()] = sum(values) / len(values) if values else None
        result[name + "DefinedImages"] = len(values)
    tp, fp, fn = (sum(row[key] for row in rows) for key in ("tp", "fp", "fn"))
    result["pixels"] = {"tp": tp, "fp": fp, "fn": fn,
                        "precision": tp / (tp + fp) if tp + fp else None,
                        "recall": tp / (tp + fn) if tp + fn else None}
    return result


def grouped_intervals(rows, seed=20261105):
    groups = {}
    for row in rows:
        key = row.get("group") or row["id"]
        counts = groups.setdefault(key, [0, 0, 0])
        for index, name in enumerate(("tp", "fp", "fn")):
            counts[index] += row[name]
    if len(groups) < 2:
        return {"groups": len(groups), "precision95": None, "recall95": None}
    rng, counts = random.Random(seed), list(groups.values())
    samples = {"precision": [], "recall": []}
    for _ in range(1000):
        chosen = rng.choices(counts, k=len(counts))
        tp, fp, fn = (sum(row[index] for row in chosen) for index in range(3))
        for name, denominator in (("precision", tp + fp), ("recall", tp + fn)):
            if denominator:
                samples[name].append(tp / denominator)
    result = {"groups": len(groups), "resamples": 1000, "seed": seed,
              "scope": "Bootstrap por prefijo declarado, no confirmacion de pacientes ni validacion clinica."}
    for name, values in samples.items():
        values.sort()
        result[name + "95"] = [values[int((len(values) - 1) * q)] for q in (.025, .975)] if values else None
    return result


def component_boxes(mask, probabilities=None):
    """Componentes 8-conexos sin top-N ni filtro de tamano; no lesiones clinicas."""
    import numpy as np
    active = np.asarray(mask, dtype=bool)
    if active.ndim != 2 or not active.size or (probabilities is not None and probabilities.shape != active.shape):
        raise ValueError("Componentes requieren una mascara 2D y probabilidades de igual tamano.")
    height, width = active.shape
    seen, boxes = np.zeros_like(active), []
    for y, x in zip(*np.nonzero(active)):
        if seen[y, x]:
            continue
        pending, left, top, right, bottom, total, count = [(int(x), int(y))], int(x), int(y), int(x), int(y), 0., 0
        seen[y, x] = True
        while pending:
            cx, cy = pending.pop()
            left, top, right, bottom = min(left, cx), min(top, cy), max(right, cx), max(bottom, cy)
            count += 1
            if probabilities is not None:
                total += float(probabilities[cy, cx])
            for ny in range(max(0, cy - 1), min(height, cy + 2)):
                for nx in range(max(0, cx - 1), min(width, cx + 2)):
                    if active[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        pending.append((nx, ny))
        box = {"category": "melasma", "x": left / width, "y": top / height,
               "width": (right - left + 1) / width, "height": (bottom - top + 1) / height}
        if probabilities is not None:
            box["score"] = total / count
        boxes.append(box)
        if len(boxes) > 2000:
            raise ValueError("Mas de 2000 componentes; no se truncan silenciosamente.")
    return boxes


def load_manifest(root):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or manifest.get("source") not in ("ISIC-2017", "MEMI-DS"):
        raise ValueError("Manifiesto no reconocido.")
    if validate_pairs(manifest["images"], manifest["source"]) != manifest["counts"]:
        raise ValueError("Conteos inconsistentes en el manifiesto.")
    for item in manifest["images"]:
        for suffix, key in ((".jpg", "imageSha256"), ("_mask.png", "maskSha256")):
            if digest((root / (item["id"] + suffix)).read_bytes()) != item[key]:
                raise ValueError("Par alterado respecto al manifiesto: " + item["id"])
    return manifest


def make_model():
    from torchvision.models.segmentation import lraspp_mobilenet_v3_large
    # Sin pesos externos ni descargas implicitas.
    return lraspp_mobilenet_v3_large(weights=None, weights_backbone=None, num_classes=2)


def cached_entry(identifier, photo, mask, size):
    import torch
    image, target, valid = letterbox(photo, mask, size)
    return identifier, ((image + 1) * 127.5).round().to(torch.uint8), target, valid


def weak_memi_entries(root, manifest, size):
    import numpy as np
    from PIL import Image
    if manifest["source"] != "MEMI-DS":
        raise ValueError("Anotaciones debiles disponibles solo para MEMI auditado.")
    metadata_bytes = (root / "source-metadata.json").read_bytes()
    if digest(metadata_bytes) != manifest["sourceMetadataSha256"]:
        raise ValueError("Metadatos MEMI alterados.")
    pairs = memi_pairs(json.loads(metadata_bytes)["files"])
    training_groups = {item["group"] for item in manifest["images"] if item["split"] == "train"}
    entries, provenance = [], []
    for excluded in manifest["excluded"]:
        identifier = excluded["id"]
        match = re.fullmatch(r"MEMI_(\d+)_[FLR]", identifier)
        if match is None:
            raise ValueError("ID de anotacion debil invalido.")
        if match[1] not in training_groups:
            continue
        name = identifier.removeprefix("MEMI_")
        image_bytes = (root / (identifier + ".jpg")).read_bytes()
        mask_bytes = (root / (identifier + "_source.png")).read_bytes()
        for extension, content in (("jpg", image_bytes), ("png", mask_bytes)):
            if hashlib.md5(content, usedforsecurity=False).hexdigest() != pairs[name][extension]["computed_md5"]:
                raise ValueError("Anotacion debil no coincide con el archivo del editor.")
        with Image.open(io.BytesIO(image_bytes)) as photo, Image.open(io.BytesIO(mask_bytes)) as mask:
            values = np.asarray(mask)
            if photo.size != mask.size or values.ndim != 2 or values.dtype != np.uint8 or values.min() != 0 or values.max() > 5:
                raise ValueError("Formato de anotacion debil no reconocido.")
            geometry(*photo.size, size)
            foreground = Image.fromarray((values > 0).astype("uint8") * 255)
            entries.append(cached_entry(identifier, photo, foreground, size))
        provenance.append({"id": identifier, "group": match[1], "weight": .15,
                           "imageSha256": digest(image_bytes), "sourceMaskSha256": digest(mask_bytes),
                           "label": "unclassified-annotation-foreground",
                           "quality": "weak-training-only-not-clinical-reference"})
    if not entries:
        raise ValueError("No hay anotaciones debiles elegibles en los grupos de entrenamiento.")
    return entries, provenance


def training_crop_boxes(mask, seed):
    """Dos escalas adicionales solo de entrenamiento; coordenadas originales."""
    width, height = mask.size
    bounds = mask.getbbox()
    if bounds is None:
        raise ValueError("No hay anotacion para el recorte de entrenamiento.")
    left, top, right, bottom = bounds
    margin = max(1, round(max(right - left, bottom - top) * .35))
    around = (max(0, left - margin), max(0, top - margin),
              min(width, right + margin), min(height, bottom + margin))
    rng = random.Random(seed)
    w, h = max(1, round(width * .65)), max(1, round(height * .65))
    x, y = rng.randrange(width - w + 1), rng.randrange(height - h + 1)
    return [around, (x, y, x + w, y + h)]


def available_memory_bytes():
    if sys.platform != "win32":
        return None
    import ctypes

    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                    ("total", ctypes.c_ulonglong), ("available", ctypes.c_ulonglong),
                    ("pageTotal", ctypes.c_ulonglong), ("pageAvailable", ctypes.c_ulonglong),
                    ("virtualTotal", ctypes.c_ulonglong), ("virtualAvailable", ctypes.c_ulonglong),
                    ("extendedAvailable", ctypes.c_ulonglong)]

    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    if not ctypes.WinDLL("kernel32", use_last_error=True).GlobalMemoryStatusEx(ctypes.byref(status)):
        raise ctypes.WinError(ctypes.get_last_error())
    return status.available


def train(args):
    import numpy as np
    import torch
    from PIL import Image
    from torchvision.transforms import ColorJitter
    root, output = Path(args.data), Path(args.output)
    manifest = load_manifest(root)
    output.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(args.threads)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.use_deterministic_algorithms(True)
    data = {}
    crop_provenance = []
    for split in PARTITIONS:
        entries = []
        if split == "test" and args.validation_only:
            data[split] = entries
            continue
        for item in manifest["images"]:
            if item["split"] != split:
                continue
            with Image.open(root / (item["id"] + ".jpg")) as photo, Image.open(root / (item["id"] + "_mask.png")) as mask:
                entries.append(cached_entry(item["id"], photo, mask, args.size))
                if split == "train" and args.training_crops:
                    boxes = training_crop_boxes(mask, args.seed + len(crop_provenance))
                    for index, box in enumerate(boxes):
                        identifier = item["id"] + "-crop-" + str(index)
                        entries.append(cached_entry(identifier, photo.crop(box), mask.crop(box), args.size))
                        crop_provenance.append({"id": identifier, "sourceId": item["id"], "box": box,
                                                "quality": "transformed-training-reference-only"})
        data[split] = entries
    weak_provenance = []
    if args.weak_foreground:
        extra, weak_provenance = weak_memi_entries(root, manifest, args.size)
        data["train"].extend(extra)
    sample_weights = {entry["id"]: entry["weight"] for entry in weak_provenance}
    model = make_model()
    initialization = None
    if args.initialize:
        initial = Path(args.initialize)
        if initial.stat().st_size > 100_000_000:
            raise ValueError("Inicializacion excede 100 MB.")
        initial_checkpoint = torch.load(initial, map_location="cpu", weights_only=True)
        if initial_checkpoint.get("architecture") != ARCHITECTURE:
            raise ValueError("Inicializacion incompatible.")
        model.load_state_dict(initial_checkpoint["state_dict"], strict=True)
        initialization = digest(initial.read_bytes())
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=.0001)
    jitter = ColorJitter(brightness=.15, contrast=.15, saturation=.1)

    def probabilities(split):
        model.eval()
        predictions = []
        with torch.inference_mode():
            for _, image, target, valid in data[split]:
                probability = model((image.float() / 127.5 - 1).unsqueeze(0))["out"].softmax(1)[0, 1]
                predictions.append((probability[valid].numpy(), target[valid].numpy()))
        return predictions

    start = time.monotonic()
    deadline = start + args.minutes * 60
    best, checkpoint, history, steps = -1, None, [], 0
    stop_reason, minimum_memory = "epoch-limit", None
    for epoch in range(args.epochs):
        model.train()
        order = list(range(len(data["train"])))
        random.shuffle(order)
        losses = []
        for offset in range(0, len(order), args.batch):
            available = available_memory_bytes()
            if available is not None:
                minimum_memory = min(minimum_memory, available) if minimum_memory is not None else available
                if available < 512 * 1024 * 1024:
                    stop_reason = "memory-pressure"
                    print("RAM libre inferior a 512 MiB; se detiene el ajuste sin ampliar carga.", flush=True)
                    break
            if time.monotonic() >= deadline - 30:
                stop_reason = "time-budget"
                break
            batch = [data["train"][i] for i in order[offset:offset + args.batch]]
            xs, ys, vs, weights = [], [], [], []
            for identifier, image, target, valid in batch:
                image, target, valid = image.float() / 127.5 - 1, target.clone(), valid.clone()
                if random.random() < .5:
                    image, target, valid = image.flip(-1), target.flip(-1), valid.flip(-1)
                if manifest["source"] == "ISIC-2017" and random.random() < .5:
                    image, target, valid = image.flip(-2), target.flip(-2), valid.flip(-2)
                xs.append(jitter((image + 1) / 2) * 2 - 1)
                ys.append(target)
                vs.append(valid)
                weights.append(sample_weights.get(identifier, 1))
            x, y, valid = torch.stack(xs), torch.stack(ys).long(), torch.stack(vs)
            optimizer.zero_grad(set_to_none=True)
            logits = model(x)["out"]
            weight = torch.tensor(weights).view(-1, 1, 1).expand_as(y)[valid]
            ce = (torch.nn.functional.cross_entropy(logits, y, reduction="none")[valid] * weight).sum() / weight.sum()
            p, t = logits.softmax(1)[:, 1][valid], y[valid].float()
            loss = ce + 1 - (2 * (p * t * weight).sum() + 1) / ((p * weight).sum() + (t * weight).sum() + 1)
            if not torch.isfinite(loss):
                raise ValueError("Entrenamiento no finito; no se publico un modelo.")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1)
            optimizer.step()
            steps += 1
            losses.append(loss.item())
        if not losses:
            break
        validation = summarize([segmentation_metrics(p >= .5, t) for p, t in probabilities("validation")])
        score = validation["macroIou"]
        row = {"epoch": epoch + 1, "steps": steps, "loss": sum(losses) / len(losses), "validationMacroIoU": score}
        history.append(row)
        print(json.dumps(row), flush=True)
        if score > best:
            best = score
            checkpoint = {key: value.detach().clone() for key, value in model.state_dict().items()}
        if stop_reason == "memory-pressure" or time.monotonic() >= deadline - 30:
            if stop_reason != "memory-pressure":
                stop_reason = "time-budget"
            break
    if checkpoint is None:
        raise ValueError("No se entreno y valido ninguna epoca. Motivo: " + stop_reason)
    model.load_state_dict(checkpoint)
    val = probabilities("validation")
    threshold_scores = [(threshold, summarize([segmentation_metrics(p >= threshold, t) for p, t in val]))
                        for threshold in (.25, .35, .5, .65, .75)]
    threshold, validation = max(threshold_scores, key=lambda pair: pair[1]["macroIou"])
    test = probabilities("test") if not args.validation_only else []
    metrics = summarize([segmentation_metrics(p >= threshold, t) for p, t in test]) if test else None
    foreground = summarize([segmentation_metrics(np.ones_like(t), t) for _, t in test]) if test else None
    checkpoint_path = output / "model.pt"
    category = manifest.get("category")
    torch.save({"architecture": ARCHITECTURE, "state_dict": checkpoint, "size": args.size,
                "threshold": threshold, "normalization": "rgb-div127.5-minus1",
                "category": category, "source": manifest["source"],
                "eligibleForClinicalUse": False}, checkpoint_path)
    elapsed = time.monotonic() - start
    report = {
        "version": 1, "architecture": ARCHITECTURE, "pretrainedWeights": initialization is not None,
        "externalPretrainedWeights": False,
        "initializationSha256": initialization, "source": manifest["source"], "category": category,
        "learningRate": args.learning_rate,
        "weakTraining": weak_provenance,
        "trainingCrops": crop_provenance,
        "cachedDataBytes": sum(tensor.nelement() * tensor.element_size()
                               for entries in data.values() for _, *tensors in entries for tensor in tensors),
        "cachedImageEncoding": "uint8-lossless; normalized per batch",
        "stopReason": stop_reason, "minimumObservedAvailableMemoryBytes": minimum_memory,
        "memoryGuard": "Windows: detener entre lotes por debajo de 512 MiB libres; no garantiza ausencia de impacto en otros procesos.",
        "modelSha256": digest(checkpoint_path.read_bytes()), "modelBytes": checkpoint_path.stat().st_size,
        "manifestSha256": digest((root / "manifest.json").read_bytes()),
        "seed": args.seed, "threads": args.threads, "imageSize": args.size, "steps": steps,
        "trainingSecondsIncludingEvaluation": elapsed, "requestedMinutes": args.minutes,
        "counts": manifest["counts"], "history": history, "threshold": threshold,
        "thresholdChosenOn": "validation", "validation": validation, "test": metrics,
        "testEvaluated": not args.validation_only,
        "allForegroundBaselineTest": foreground, "torch": torch.__version__,
        "eligibleForClinicalUse": False, "categories": {name: "not-evaluated" for name in CATEGORIES},
        "independence": manifest["independence"],
        "scope": "Segmentacion binaria a resolucion de ensayo, excluye padding. No precision/recall por lesion o diagnostico, no mAP ni validacion clinica.",
        "limits": manifest.get("annotationLimits", "Muestra pequena estratificada; pacientes/lesiones y duplicados perceptuales no verificados. No usar para diagnostico, descartar malignidad ni afirmar >70% facial."),
    }
    if category:
        report["categories"][category] = "experimental-segmentation-only"
    if report["modelBytes"] > 100_000_000:
        checkpoint_path.unlink()
        raise ValueError("Modelo excede los 100 MB autorizados.")
    write_json(output / "report.json", report)
    print(json.dumps({key: report[key] for key in ("modelBytes", "steps", "trainingSecondsIncludingEvaluation", "test")}), flush=True)


def evaluate(args):
    import numpy as np
    import torch
    from PIL import Image
    root, output = Path(args.data), Path(args.output)
    manifest = load_manifest(root)
    checkpoint_path = Path(args.model)
    if checkpoint_path.stat().st_size > 100_000_000:
        raise ValueError("Modelo excede los 100 MB autorizados.")
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    validate_checkpoint(checkpoint)
    if checkpoint.get("source") != manifest["source"] or checkpoint.get("category") != manifest.get("category"):
        raise ValueError("Modelo y conjunto no comparten origen/taxonomia.")
    output.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(args.threads)
    model = make_model()
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.eval()
    rows, foreground, references, predictions = [], [], [], []
    with torch.inference_mode():
        for item in manifest["images"]:
            if item["split"] != "test":
                continue
            with Image.open(root / (item["id"] + ".jpg")) as photo, Image.open(root / (item["id"] + "_mask.png")) as mask:
                original_size = photo.size
                image, truth, valid = letterbox(photo, mask, checkpoint["size"])
            full_probability = model(image.unsqueeze(0))["out"].softmax(1)[0, 1].numpy()
            if manifest.get("category") == "melasma":
                w, h, x, y = geometry(*original_size, checkpoint["size"])
                cropped = full_probability[y:y + h, x:x + w]
                references.append({"id": item["id"], "group": item["group"],
                                   "boxes": component_boxes(truth[y:y + h, x:x + w].numpy())})
                predictions.append({"id": item["id"], "boxes": component_boxes(cropped >= checkpoint["threshold"], cropped)})
            p, truth = full_probability[valid.numpy()], truth[valid].numpy()
            rows.append({"id": item["id"], "group": item.get("group"),
                         **segmentation_metrics(p >= checkpoint["threshold"], truth)})
            foreground.append(segmentation_metrics(np.ones_like(truth), truth))
    precision_recall = summarize(rows)["pixels"]
    if manifest.get("category") == "melasma":
        write_json(output / "region-references.json", {
            "version": 1, "trainingGroups": sorted({item["group"] for item in manifest["images"] if item["split"] == "train"}),
            "images": references,
        })
        write_json(output / "region-predictions.json", {
            "version": 1, "model": "memi-" + digest(checkpoint_path.read_bytes())[:16], "images": predictions,
        })
    write_json(output / "evaluation.json", {
        "version": 1, "source": manifest["source"], "category": manifest.get("category"),
        "modelSha256": digest(checkpoint_path.read_bytes()),
        "manifestSha256": digest((root / "manifest.json").read_bytes()),
        "threshold": checkpoint["threshold"], "thresholdChanged": False,
        "test": summarize(rows), "perImage": rows, "allForegroundBaseline": summarize(foreground),
        "groupedPixelIntervals": grouped_intervals(rows),
        "observedPixelPrecisionRecallAbove70": all(precision_recall[k] is not None and precision_recall[k] > .7
                                                   for k in ("precision", "recall")),
        "eligibleForClinicalUse": False, "independence": manifest["independence"],
        "scope": "Solo segmentacion de la etiqueta de origen a resolucion de ensayo. No deteccion por lesion, clasificacion diferencial, negativos sanos independientes ni validacion clinica.",
        "regionScope": "Cajas de componentes 8-conexos de las mascaras escaladas sin padding, normalizadas a la foto. No equivalen a instancias clinicas ni prueban clasificacion diferencial. Evaluar ambos JSON con lab:skin-evaluate.",
    })
    print(json.dumps(summarize(rows)), flush=True)


def validate_checkpoint(checkpoint):
    if (checkpoint.get("architecture") != ARCHITECTURE or checkpoint.get("normalization") != "rgb-div127.5-minus1"
            or type(checkpoint.get("size")) is not int or not 64 <= checkpoint["size"] <= 512
            or not isinstance(checkpoint.get("threshold"), (int, float))
            or not math.isfinite(checkpoint["threshold"]) or not 0 <= checkpoint["threshold"] <= 1
            or checkpoint.get("category") not in (None, "melasma")):
        raise ValueError("Checkpoint incompatible.")


def predict(args):
    import numpy as np
    import torch
    from PIL import Image
    checkpoint_path = Path(args.model)
    if checkpoint_path.stat().st_size > 100_000_000:
        raise ValueError("Modelo excede los 100 MB autorizados.")
    torch.set_num_threads(args.threads)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    validate_checkpoint(checkpoint)
    model = make_model()
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.eval()
    with Image.open(args.image) as photo:
        original_size = photo.size
        image, _, _ = letterbox(photo, None, checkpoint["size"])
    with torch.inference_mode():
        probability = model(image.unsqueeze(0))["out"].softmax(1)[0, 1].numpy()
    w, h, x, y = geometry(*original_size, checkpoint["size"])
    probability = np.array(Image.fromarray(probability[y:y + h, x:x + w]).resize(original_size, Image.Resampling.BILINEAR))
    binary = probability >= checkpoint["threshold"]
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    Image.fromarray((binary * 255).astype("uint8")).save(output / "mask.png")
    Image.fromarray((probability * 255).clip(0, 255).astype("uint8")).save(output / "probability.png")
    rows, cols = np.nonzero(binary)
    width, height = original_size
    box = {"x": int(cols.min()) / width, "y": int(rows.min()) / height,
           "width": int(cols.max() - cols.min() + 1) / width,
           "height": int(rows.max() - rows.min() + 1) / height} if len(rows) else None
    write_json(output / "prediction.json", {
        "version": 1, "modelSha256": digest(checkpoint_path.read_bytes()),
        "width": width, "height": height, "threshold": checkpoint["threshold"],
        "foregroundBox": box, "category": checkpoint.get("category"), "eligibleForClinicalUse": False,
        "scope": "Mascara experimental en coordenadas originales; probabilidades no calibradas. Etiqueta del entrenamiento, no diagnostico ni prueba de ausencia de lesiones.",
    })


def export_web(args):
    import numpy as np
    import onnx
    import torch
    from PIL import Image

    checkpoint_path, output = Path(args.model), Path(args.output)
    if checkpoint_path.stat().st_size > 100_000_000:
        raise ValueError("Modelo excede los 100 MB autorizados.")
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    validate_checkpoint(checkpoint)
    torch.set_num_threads(args.threads)
    model = make_model().eval()
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    size, threshold = checkpoint["size"], checkpoint["threshold"]

    class Foreground(torch.nn.Module):
        def __init__(self, base):
            super().__init__()
            self.base = base

        def forward(self, image):
            return self.base(image)["out"].softmax(1)[:, 1:2]

    wrapped = Foreground(model).eval()
    generator = torch.Generator().manual_seed(20261105)
    samples = [("synthetic-zero", torch.zeros(1, 3, size, size)),
               ("synthetic-noise", torch.rand(1, 3, size, size, generator=generator) * 2 - 1)]
    data_hash = None
    if args.data:
        root = Path(args.data)
        manifest = load_manifest(root)
        if checkpoint.get("source") != manifest["source"] or checkpoint.get("category") != manifest.get("category"):
            raise ValueError("Modelo y conjunto no comparten origen/taxonomia.")
        data_hash = digest((root / "manifest.json").read_bytes())
        for item in manifest["images"]:
            if item["split"] != "validation":
                continue
            with Image.open(root / (item["id"] + ".jpg")) as photo:
                image, _, _ = letterbox(photo, None, size)
            samples.append(("validation-" + str(len(samples) - 1), image.unsqueeze(0)))
    output.mkdir(parents=True, exist_ok=False)
    temporary = output / "model.partial.onnx"
    with torch.inference_mode():
        torch.onnx.export(wrapped, samples[0][1], str(temporary), opset_version=17,
                          input_names=["image"], output_names=["probability"], dynamo=False)
    if temporary.stat().st_size > 100_000_000:
        raise ValueError("Exportacion excede 100 MB; no se publica el manifiesto.")
    graph = onnx.load(temporary)
    if ([item.name for item in graph.graph.input] != ["image"] or
            [item.name for item in graph.graph.output] != ["probability"] or
            [dimension.dim_value for dimension in graph.graph.input[0].type.tensor_type.shape.dim] != [1, 3, size, size] or
            [dimension.dim_value for dimension in graph.graph.output[0].type.tensor_type.shape.dim] != [1, 1, size, size]):
        raise ValueError("El contrato no coincide con las entradas/salidas del grafo ONNX.")
    del graph
    cases = []
    with torch.inference_mode():
        for name, image in samples:
            tensor = image.numpy()
            expected = wrapped(image).numpy()
            if not np.isfinite(expected).all():
                raise ValueError("Referencia PyTorch no finita; no se publica el manifiesto.")
            files = {}
            for kind, array in (("input", tensor), ("expected", expected)):
                filename = name + "-" + kind + ".f32"
                content = array.astype("<f4").tobytes()
                (output / filename).write_bytes(content)
                files[kind] = {"file": filename, "sha256": digest(content), "bytes": len(content)}
            cases.append({"name": name, **files})
    model_path = output / "model.onnx"
    temporary.rename(model_path)
    write_json(output / "model.json", {
        "version": 1, "architecture": ARCHITECTURE, "format": "onnx", "opset": 17,
        "model": {"file": model_path.name, "sha256": digest(model_path.read_bytes()),
                  "bytes": model_path.stat().st_size},
        "sourceCheckpointSha256": digest(checkpoint_path.read_bytes()),
        "validationManifestSha256": data_hash, "category": checkpoint.get("category"),
        "size": size, "threshold": threshold, "inputName": "image", "outputName": "probability",
        "inputShape": [1, 3, size, size], "outputShape": [1, 1, size, size],
        "normalization": "rgb-div127.5-minus1", "encoding": "little-endian-float32",
        "geometry": "Letterbox centrado, RGB bilineal PIL, padding negro; recortar padding antes de invertir coordenadas.",
        "tolerances": {"maxAbsoluteError": .0001, "minimumMaskAgreement": .999},
        "cases": cases, "browserQualificationRequired": True, "eligibleForClinicalUse": False,
        "disclaimer": "Asistente experimental de analisis visual. No es un diagnostico medico, no identifica ni descarta enfermedades ni sustituye la evaluacion profesional.",
        "scope": "Paridad de inferencia, no mejora de precision ni validacion clinica. Entradas de validacion preprocesadas, no prueba de equivalencia de un decodificador de fotos en navegador. No despliegue automatico.",
    })
    print(json.dumps({"modelBytes": model_path.stat().st_size, "referenceCases": len(cases),
                      "browserQualificationRequired": True,
                      "eligibleForClinicalUse": False}), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("prepare", help="Descarga acotada de pares publicos CC0; directorio nuevo.")
    p.add_argument("--output", required=True)
    p.add_argument("--max-mb", type=int, default=100)
    p.add_argument("--train", type=int, default=96)
    p.add_argument("--validation", type=int, default=24)
    p.add_argument("--test", type=int, default=24)
    p.add_argument("--seed", type=int, default=20261105)
    p.add_argument("--resume", action="store_true", help="Reusa pares/cache y conserva bytes gastados del intento fallido.")
    p = commands.add_parser("prepare-memi", help="Descarga MEMI v1 CC BY 4.0, conserva paleta y agrupa vistas.")
    p.add_argument("--output", required=True)
    p.add_argument("--max-mb", type=int, default=200)
    p.add_argument("--seed", type=int, default=20261105)
    p.add_argument("--resume", action="store_true", help="Conserva bytes gastados y verifica cache con MD5 del editor.")
    p = commands.add_parser("train", help="Aprende desde cero, sin red ni pesos externos.")
    p.add_argument("--data", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--minutes", type=float, default=10)
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--size", type=int, default=160)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--seed", type=int, default=20261105)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--initialize", help="Checkpoint propio compatible <=100 MB, sin descarga implicita.")
    p.add_argument("--learning-rate", type=float, default=.003)
    p.add_argument("--budget-ledger", help="Obligatorio por encima de 10 minutos; reserva acumulada maxima de 60 minutos.")
    p.add_argument("--validation-only", action="store_true", help="No abre test para inferencia/seleccion; evaluar solo el modelo congelado despues.")
    p.add_argument("--weak-foreground", action="store_true", help="MEMI: union de etiquetas ambiguas solo en grupos de entrenamiento, peso 0.15; nunca referencia clinica.")
    p.add_argument("--training-crops", action="store_true", help="Dos escalas adicionales de las referencias de entrenamiento; no modifica validacion/test.")
    p = commands.add_parser("evaluate", help="Evalua test con modelo/umbral congelados; directorio nuevo.")
    p.add_argument("--model", required=True)
    p.add_argument("--data", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p = commands.add_parser("predict", help="Inferencia local experimental sobre una imagen; no API.")
    p.add_argument("--model", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p = commands.add_parser("export-web", help="Exporta ONNX y referencias PyTorch para verificar en navegador; no entrena ni infiere test.")
    p.add_argument("--model", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--data", help="Agrega solo entradas de validacion auditadas; tensores locales reconstruibles, no subirlos.")
    p.add_argument("--threads", type=int, default=2)
    args = parser.parse_args(argv)
    if args.command == "prepare" and (not 1 <= args.max_mb <= 100 or any(not 2 <= getattr(args, key) <= 500 for key in PARTITIONS)):
        parser.error("Datos: 1-100 MB y 2-500 imagenes por particion.")
    if args.command == "prepare-memi" and not 1 <= args.max_mb <= 1000:
        parser.error("MEMI: presupuesto maximo de 1000 MB.")
    if args.command == "train" and (not math.isfinite(args.minutes) or not 1 <= args.minutes <= 60
                                    or not 64 <= args.size <= 256 or not 2 <= args.batch <= 16 or not 1 <= args.epochs <= 500):
        parser.error("Ensayo: 1-60 minutos, 64-256 px, batch 2-16 y 1-500 epocas.")
    if args.command == "train" and (not math.isfinite(args.learning_rate) or not 0 < args.learning_rate <= .01):
        parser.error("Learning rate debe estar entre 0 (exclusivo) y 0.01.")
    if args.command == "train" and args.minutes > 10 and not args.budget_ledger:
        parser.error("Reserva los ensayos largos con --budget-ledger; no reiniciar presupuesto entre intentos.")
    if hasattr(args, "threads") and not 1 <= args.threads <= 2:
        parser.error("Usa 1-2 hilos para no monopolizar el equipo compartido.")
    try:
        if args.command == "train" and args.budget_ledger:
            reserve_training_budget(Path(args.budget_ledger), args.minutes)
        {"prepare": prepare, "prepare-memi": prepare_memi, "train": train, "predict": predict,
         "evaluate": evaluate, "export-web": export_web}[args.command](args)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, RuntimeError) as error:
        print(f"No se completo {args.command}: {error}", file=sys.stderr)
        return 1
    return 0


def reserve_training_budget(path, minutes):
    if not math.isfinite(minutes) or not 0 < minutes <= 60:
        raise ValueError("Reserva de tiempo invalida.")
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_suffix(path.suffix + ".lock")
    handle = lock.open("x", encoding="utf-8")
    try:
        with handle:
            prior = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"reservedMinutes": 0}
            reserved = prior.get("reservedMinutes")
            if not isinstance(reserved, (int, float)) or not math.isfinite(reserved) or not 0 <= reserved <= 60:
                raise ValueError("Registro de presupuesto invalido.")
            if reserved + minutes > 60:
                raise ValueError("Se agoto el presupuesto acumulado de 60 minutos.")
            write_json(path, {"reservedMinutes": reserved + minutes, "limitMinutes": 60,
                             "policy": "Reserva previa conservadora; errores/cancelaciones no reinician ni devuelven tiempo."})
    finally:
        lock.unlink()


if __name__ == "__main__":
    sys.exit(main())
