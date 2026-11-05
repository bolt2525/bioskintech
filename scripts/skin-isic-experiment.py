"""Ensayo local de segmentacion ISIC CC0. No diagnostico ni detector facial."""

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


class OversizedRemoteFile(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


class Budget:
    def __init__(self, maximum):
        self.maximum = maximum
        self.used = 0

    def consume(self, amount):
        if amount < 0 or self.used + amount > self.maximum:
            raise ValueError("Tope de descarga alcanzado; no se completo la muestra.")
        self.used += amount

    def fetch(self, url, maximum):
        allowed = ("https://api.isic-archive.com/api/v2/images/",
                   "https://isic-archive.s3.amazonaws.com/")
        if not url.startswith(allowed):
            raise ValueError("Origen de descarga no permitido.")
        limit = min(maximum, self.maximum - self.used)
        if limit <= 0:
            raise ValueError("Tope de descarga alcanzado.")
        # No se siguen redirecciones a hosts ajenos al archivo publico.
        class Redirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                if not newurl.startswith(allowed):
                    raise ValueError("Redireccion fuera de ISIC rechazada.")
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


def validate_pairs(images):
    if not isinstance(images, list):
        raise ValueError("Se requiere una lista de pares.")
    ids, hashes = set(), set()
    counts = Counter()
    for item in images:
        if (not isinstance(item, dict) or not isinstance(item.get("split"), str) or item["split"] not in PARTITIONS
                or not isinstance(item.get("id"), str) or not re.fullmatch(r"ISIC_\d{7}", item["id"])
                or not isinstance(item.get("imageSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", item["imageSha256"])):
            raise ValueError("Particion o identificador invalido.")
        if item.get("license") != "CC-0":
            raise ValueError("Se requiere CC0 por imagen, ademas de la licencia del desafio.")
        if item["id"] in ids or item["imageSha256"] in hashes:
            raise ValueError("Imagen repetida entre particiones o dentro de ellas.")
        ids.add(item["id"])
        hashes.add(item["imageSha256"])
        counts[item["split"]] += 1
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
    target = torch.zeros((size, size), dtype=torch.long)
    if mask is not None:
        resized = mask.convert("L").resize((w, h), Image.Resampling.NEAREST)
        target[y:y + h, x:x + w] = torch.from_numpy((np.array(resized) > 127).astype("int64"))
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


def load_manifest(root):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or manifest.get("source") != "ISIC-2017":
        raise ValueError("Manifiesto no reconocido.")
    if validate_pairs(manifest["images"]) != manifest["counts"]:
        raise ValueError("Conteos inconsistentes en el manifiesto.")
    for item in manifest["images"]:
        for suffix, key in ((".jpg", "imageSha256"), ("_mask.png", "maskSha256")):
            if digest((root / (item["id"] + suffix)).read_bytes()) != item[key]:
                raise ValueError("Par alterado respecto al manifiesto: " + item["id"])
    return manifest


def make_model():
    from torchvision.models.segmentation import lraspp_mobilenet_v3_large
    # Sin pesos externos ni descargas implicitas; se aprende solo de los pares CC0.
    return lraspp_mobilenet_v3_large(weights=None, weights_backbone=None, num_classes=2)


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
    for split in PARTITIONS:
        entries = []
        for item in manifest["images"]:
            if item["split"] != split:
                continue
            with Image.open(root / (item["id"] + ".jpg")) as photo, Image.open(root / (item["id"] + "_mask.png")) as mask:
                entries.append((item["id"], *letterbox(photo, mask, args.size)))
        data[split] = entries
    model = make_model()
    optimizer = torch.optim.AdamW(model.parameters(), lr=.003, weight_decay=.0001)
    jitter = ColorJitter(brightness=.15, contrast=.15, saturation=.1)

    def probabilities(split):
        model.eval()
        predictions = []
        with torch.inference_mode():
            for _, image, target, valid in data[split]:
                probability = model(image.unsqueeze(0))["out"].softmax(1)[0, 1]
                predictions.append((probability[valid].numpy(), target[valid].numpy()))
        return predictions

    start = time.monotonic()
    deadline = start + args.minutes * 60
    best, checkpoint, history, steps = -1, None, [], 0
    for epoch in range(args.epochs):
        model.train()
        order = list(range(len(data["train"])))
        random.shuffle(order)
        losses = []
        for offset in range(0, len(order), args.batch):
            if time.monotonic() >= deadline - 30:
                break
            batch = [data["train"][i] for i in order[offset:offset + args.batch]]
            xs, ys, vs = [], [], []
            for _, image, target, valid in batch:
                image, target, valid = image.clone(), target.clone(), valid.clone()
                if random.random() < .5:
                    image, target, valid = image.flip(-1), target.flip(-1), valid.flip(-1)
                if random.random() < .5:
                    image, target, valid = image.flip(-2), target.flip(-2), valid.flip(-2)
                xs.append(jitter((image + 1) / 2) * 2 - 1)
                ys.append(target)
                vs.append(valid)
            x, y, valid = torch.stack(xs), torch.stack(ys), torch.stack(vs)
            optimizer.zero_grad(set_to_none=True)
            logits = model(x)["out"]
            ce = torch.nn.functional.cross_entropy(logits, y, reduction="none")[valid].mean()
            p, t = logits.softmax(1)[:, 1][valid], y[valid].float()
            loss = ce + 1 - (2 * (p * t).sum() + 1) / (p.sum() + t.sum() + 1)
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
        if time.monotonic() >= deadline - 30:
            break
    if checkpoint is None:
        raise ValueError("Presupuesto insuficiente para entrenar y validar al menos una epoca.")
    model.load_state_dict(checkpoint)
    val = probabilities("validation")
    threshold_scores = [(threshold, summarize([segmentation_metrics(p >= threshold, t) for p, t in val]))
                        for threshold in (.25, .35, .5, .65, .75)]
    threshold, validation = max(threshold_scores, key=lambda pair: pair[1]["macroIou"])
    test = probabilities("test")
    metrics = summarize([segmentation_metrics(p >= threshold, t) for p, t in test])
    foreground = summarize([segmentation_metrics(np.ones_like(t), t) for _, t in test])
    checkpoint_path = output / "model.pt"
    torch.save({"architecture": ARCHITECTURE, "state_dict": checkpoint, "size": args.size,
                "threshold": threshold, "normalization": "rgb-div127.5-minus1"}, checkpoint_path)
    elapsed = time.monotonic() - start
    report = {
        "version": 1, "architecture": ARCHITECTURE, "pretrainedWeights": False,
        "modelSha256": digest(checkpoint_path.read_bytes()), "modelBytes": checkpoint_path.stat().st_size,
        "manifestSha256": digest((root / "manifest.json").read_bytes()),
        "seed": args.seed, "threads": args.threads, "imageSize": args.size, "steps": steps,
        "trainingSecondsIncludingEvaluation": elapsed, "requestedMinutes": args.minutes,
        "counts": manifest["counts"], "history": history, "threshold": threshold,
        "thresholdChosenOn": "validation", "validation": validation, "test": metrics,
        "allForegroundBaselineTest": foreground, "torch": torch.__version__,
        "eligibleForClinicalUse": False, "categories": {name: "not-evaluated" for name in CATEGORIES},
        "independence": manifest["independence"],
        "scope": "Segmentacion binaria dermatoscopica a resolucion de ensayo, excluye padding. No precision/recall por lesion o categoria, no mAP ni validacion en retratos.",
        "limits": "Muestra pequena estratificada; pacientes/lesiones y duplicados perceptuales no verificados. No usar para diagnostico, descartar malignidad ni afirmar >70% facial.",
    }
    if report["modelBytes"] > 100_000_000:
        checkpoint_path.unlink()
        raise ValueError("Modelo excede los 100 MB autorizados.")
    write_json(output / "report.json", report)
    print(json.dumps({key: report[key] for key in ("modelBytes", "steps", "trainingSecondsIncludingEvaluation", "test")}), flush=True)


def predict(args):
    import numpy as np
    import torch
    from PIL import Image
    checkpoint_path = Path(args.model)
    if checkpoint_path.stat().st_size > 100_000_000:
        raise ValueError("Modelo excede los 100 MB autorizados.")
    torch.set_num_threads(args.threads)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if (checkpoint.get("architecture") != ARCHITECTURE or checkpoint.get("normalization") != "rgb-div127.5-minus1"
            or type(checkpoint.get("size")) is not int or not 64 <= checkpoint["size"] <= 512
            or not isinstance(checkpoint.get("threshold"), (int, float))
            or not math.isfinite(checkpoint["threshold"]) or not 0 <= checkpoint["threshold"] <= 1):
        raise ValueError("Checkpoint incompatible.")
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
        "foregroundBox": box, "category": None, "eligibleForClinicalUse": False,
        "scope": "Una mascara binaria en coordenadas originales; probabilidades no calibradas. No clasifica ni demuestra ausencia de lesiones.",
    })


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
    p = commands.add_parser("train", help="Aprende desde cero, sin red ni pesos externos.")
    p.add_argument("--data", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--minutes", type=float, default=10)
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--size", type=int, default=160)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--seed", type=int, default=20261105)
    p.add_argument("--threads", type=int, default=2)
    p = commands.add_parser("predict", help="Inferencia local experimental sobre una imagen; no API.")
    p.add_argument("--model", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    args = parser.parse_args(argv)
    if args.command == "prepare" and (not 1 <= args.max_mb <= 100 or any(not 2 <= getattr(args, key) <= 500 for key in PARTITIONS)):
        parser.error("Datos: 1-100 MB y 2-500 imagenes por particion.")
    if args.command == "train" and (not math.isfinite(args.minutes) or not 1 <= args.minutes <= 10
                                    or not 64 <= args.size <= 256 or not 2 <= args.batch <= 16 or not 1 <= args.epochs <= 500):
        parser.error("Ensayo: 1-10 minutos, 64-256 px, batch 2-16 y 1-500 epocas.")
    if hasattr(args, "threads") and not 1 <= args.threads <= 4:
        parser.error("Usa 1-4 hilos para no monopolizar el equipo compartido.")
    try:
        {"prepare": prepare, "train": train, "predict": predict}[args.command](args)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, RuntimeError) as error:
        print(f"No se completo {args.command}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
