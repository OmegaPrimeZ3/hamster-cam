#!/usr/bin/env python3
"""Phase A — build a unified, single-class YOLO dataset from N Roboflow sets
plus optional LOCAL cage frames (positives + label-less background negatives).

Config-driven: every parameter comes from a pet YAML (see pets/_template.yaml).
Reads ROBOFLOW_API_KEY from the environment (never from the config).

Steps:
  1. Download each configured Roboflow dataset in YOLOv8 format.
  2. (optional) Ingest local source dirs (real cage frames):
       - role: positive -> images/ + labels/ (labels remapped to class 0)
       - role: negative -> images/ only; emitted as YOLO *background* (empty label)
  3. Merge everything into one pool; remap every label's class id to 0.
  4. De-dupe by image content hash (drops exact duplicates across all sources).
  5. 80/20 (configurable) train/val split.
  6. (optional) Oversample LOCAL samples in the TRAIN split (`local_oversample`)
     so scarce real-cage frames aren't drowned out by the larger public sets.
     Val is never oversampled, so metrics stay honest.
  7. Write a unified data.yaml with nc: 1, names: [<class_name>].

Idempotent: re-running reuses already-downloaded Roboflow folders and rebuilds
the merged dataset from scratch each time (cheap, deterministic). With no
`local_sources` configured the output is byte-for-byte identical to before.

Output: <work_dir>/dataset/{images,labels}/{train,val} + <work_dir>/dataset/data.yaml
Prints a JSON summary on the last line (consumed by run.sh / train_export.py).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
import sys
from pathlib import Path

import yaml

IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp"}


def log(msg: str) -> None:
    print(f"[build_dataset] {msg}", flush=True)


def load_config(path: Path) -> dict:
    with open(path) as fh:
        cfg = yaml.safe_load(fh)
    required = ["class_name", "work_dir", "datasets"]
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        sys.exit(f"FATAL: config {path} missing required keys: {missing}")
    if not isinstance(cfg["datasets"], list) or not cfg["datasets"]:
        sys.exit("FATAL: config 'datasets' must be a non-empty list")
    return cfg


def download_datasets(cfg: dict, work_dir: Path) -> list[Path]:
    """Download each Roboflow dataset (YOLOv8) into <work_dir>/downloads/.

    Idempotent: if the target folder already has a data.yaml we skip the pull.
    """
    api_key = os.environ.get("ROBOFLOW_API_KEY")
    if not api_key:
        sys.exit(
            "FATAL: ROBOFLOW_API_KEY is not set. Export it first:\n"
            "  export ROBOFLOW_API_KEY=rf_xxx"
        )

    from roboflow import Roboflow

    rf = Roboflow(api_key=api_key)
    downloads_root = work_dir / "downloads"
    downloads_root.mkdir(parents=True, exist_ok=True)

    paths: list[Path] = []
    for spec in cfg["datasets"]:
        ws, proj, ver = spec["workspace"], spec["project"], int(spec["version"])
        slug = f"{ws}__{proj}__v{ver}"
        dest = downloads_root / slug
        if (dest / "data.yaml").exists():
            log(f"reuse cached download: {slug}")
            paths.append(dest)
            continue
        log(f"downloading {ws}/{proj} v{ver} (yolov8) ...")
        try:
            project = rf.workspace(ws).project(proj)
            version = project.version(ver)
            # location= forces a deterministic folder; overwrite to keep idempotent.
            ds = version.download("yolov8", location=str(dest), overwrite=True)
            log(f"  -> {ds.location}")
            paths.append(Path(ds.location))
        except Exception as exc:  # noqa: BLE001 — surface the slug that failed
            sys.exit(
                f"FATAL: failed to download {ws}/{proj} v{ver}: {exc}\n"
                "Verify the workspace/project/version slug on Roboflow Universe "
                "(open the dataset -> Download -> YOLOv8 -> read the rf.workspace(...) snippet)."
            )
    return paths


def iter_split_dirs(ds_root: Path):
    """Yield (images_dir, labels_dir) for each split present in a YOLOv8 export."""
    for split in ("train", "valid", "val", "test"):
        img = ds_root / split / "images"
        lab = ds_root / split / "labels"
        if img.is_dir() and lab.is_dir():
            yield img, lab


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def remap_label(src_label: Path) -> str:
    """Return label-file text with every class id rewritten to 0. Drops empties."""
    out_lines = []
    if not src_label.exists():
        return ""
    for line in src_label.read_text().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        parts[0] = "0"  # collapse all classes to the single pet class
        out_lines.append(" ".join(parts))
    return "\n".join(out_lines)


def make_sample(img: Path, label_text: str, *, local: bool, role: str) -> dict:
    """A unified training example: the image, its (already-remapped) label text,
    and provenance used for dedupe stats + oversampling. `label_text` is "" for
    background negatives."""
    return {"img": img, "label_text": label_text, "local": local, "role": role}


def collect_local_sources(cfg: dict) -> list[dict]:
    """Read optional `local_sources:` entries into raw samples (pre-dedupe).

    Each entry: { path: <dir>, role: positive|negative }.
      positive -> <path>/images + <path>/labels (YOLOv8 layout), labels remapped.
      negative -> <path>/images only; emitted as background (empty label).
    """
    raw = cfg.get("local_sources") or []
    if not raw:
        return []
    if not isinstance(raw, list):
        sys.exit("FATAL: config 'local_sources' must be a list of {path, role}.")

    samples: list[dict] = []
    for entry in raw:
        path = Path(os.path.expanduser(str(entry.get("path", "")))).resolve()
        role = str(entry.get("role", "positive")).lower()
        if role not in {"positive", "negative"}:
            sys.exit(f"FATAL: local source {path} has invalid role '{role}' "
                     "(expected 'positive' or 'negative').")
        img_dir = path / "images"
        if not img_dir.is_dir():
            sys.exit(f"FATAL: local source {path} has no images/ subdir.")
        lab_dir = path / "labels"

        n = 0
        for img in sorted(img_dir.iterdir()):
            if img.suffix.lower() not in IMG_EXTS:
                continue
            if role == "negative":
                # Background example: keep the image, force an EMPTY label.
                samples.append(make_sample(img, "", local=True, role="negative"))
                n += 1
                continue
            # positive: must have a non-empty, remapped label to be useful.
            label_text = remap_label(lab_dir / (img.stem + ".txt"))
            if not label_text.strip():
                log(f"  skip unlabeled local positive: {img.name}")
                continue
            samples.append(make_sample(img, label_text, local=True, role="positive"))
            n += 1
        log(f"local source [{role}] {path} -> {n} images")
    return samples


def build(cfg: dict) -> dict:
    work_dir = Path(os.path.expanduser(cfg["work_dir"]))
    work_dir.mkdir(parents=True, exist_ok=True)

    ds_paths = download_datasets(cfg, work_dir)

    out_root = work_dir / "dataset"
    if out_root.exists():
        shutil.rmtree(out_root)
    for split in ("train", "val"):
        (out_root / "images" / split).mkdir(parents=True, exist_ok=True)
        (out_root / "labels" / split).mkdir(parents=True, exist_ok=True)

    # Collect samples across every Roboflow dataset/split, then local sources.
    # PUBLIC first (preserves the historical ordering + split when no local data),
    # LOCAL appended after.
    seen_hashes: set[str] = set()
    samples: list[dict] = []
    skipped_dupes = 0
    skipped_unlabeled = 0
    per_dataset_counts: dict[str, int] = {}

    for ds_root in ds_paths:
        ds_name = ds_root.name
        count = 0
        for img_dir, lab_dir in iter_split_dirs(ds_root):
            for img in sorted(img_dir.iterdir()):
                if img.suffix.lower() not in IMG_EXTS:
                    continue
                remapped = remap_label(lab_dir / (img.stem + ".txt"))
                if not remapped.strip():
                    skipped_unlabeled += 1
                    continue
                digest = file_hash(img)
                if digest in seen_hashes:
                    skipped_dupes += 1
                    continue
                seen_hashes.add(digest)
                samples.append(
                    make_sample(img, remapped, local=False, role="positive")
                )
                count += 1
        per_dataset_counts[ds_name] = count

    # Local cage frames (positives + background negatives), de-duped against
    # everything already seen (and each other).
    local_pos = local_neg = 0
    for s in collect_local_sources(cfg):
        digest = file_hash(s["img"])
        if digest in seen_hashes:
            skipped_dupes += 1
            continue
        seen_hashes.add(digest)
        samples.append(s)
        if s["role"] == "negative":
            local_neg += 1
        else:
            local_pos += 1

    if not samples:
        sys.exit("FATAL: no labeled images found across the configured sources.")

    # Deterministic shuffle + split. (Same RNG/length => same split as before for
    # the public-only case.)
    rng = random.Random(1337)
    rng.shuffle(samples)
    val_frac = float(cfg.get("val_split", 0.20))
    n_val = max(1, int(len(samples) * val_frac))
    val_samples = samples[:n_val]
    train_samples = samples[n_val:]

    # Oversample LOCAL samples in TRAIN only, so scarce cage frames carry weight
    # against the much larger public pool. Val is left untouched (honest metrics).
    oversample = max(1, int(cfg.get("local_oversample", 1)))
    expanded_train: list[dict] = []
    for s in train_samples:
        reps = oversample if s["local"] else 1
        expanded_train.extend([s] * reps)

    def emit(sample_list, split):
        for i, s in enumerate(sample_list):
            stem = f"{split}_{i:06d}"  # unique flat names; no cross-source clobber
            img = s["img"]
            shutil.copy2(img, out_root / "images" / split / f"{stem}{img.suffix.lower()}")
            # label_text is already remapped to class 0 ("" => background negative).
            (out_root / "labels" / split / f"{stem}.txt").write_text(s["label_text"])

    emit(expanded_train, "train")
    emit(val_samples, "val")

    data_yaml = {
        "path": str(out_root),
        "train": "images/train",
        "val": "images/val",
        "nc": 1,
        "names": [cfg["class_name"]],
    }
    (out_root / "data.yaml").write_text(yaml.safe_dump(data_yaml, sort_keys=False))

    # Train-split positives (excluding background negatives + oversample copies) is
    # the meaningful "how many hamster examples" figure for Gate A.
    train_positives = sum(1 for s in train_samples if s["role"] == "positive")

    summary = {
        "data_yaml": str(out_root / "data.yaml"),
        "train_images": len(train_samples),          # unique, pre-oversample
        "train_images_emitted": len(expanded_train),  # post-oversample (on disk)
        "train_positives": train_positives,
        "val_images": len(val_samples),
        "total_images": len(samples),
        "per_dataset_counts": per_dataset_counts,
        "local_positives": local_pos,
        "local_negatives": local_neg,
        "local_oversample": oversample,
        "skipped_duplicates": skipped_dupes,
        "skipped_unlabeled": skipped_unlabeled,
        "class_name": cfg["class_name"],
    }

    log(f"merged datasets: {per_dataset_counts}")
    if local_pos or local_neg:
        log(
            f"local cage frames: {local_pos} positive, {local_neg} background "
            f"negative (train oversample x{oversample})"
        )
    log(
        f"train={summary['train_images']} (emitted {summary['train_images_emitted']}) "
        f"val={summary['val_images']} "
        f"(dupes dropped={skipped_dupes}, unlabeled skipped={skipped_unlabeled})"
    )

    # Gate A — enough hamster TRAINING examples (positives; background doesn't count).
    min_train = int(cfg.get("gates", {}).get("min_train_images", 350))
    if train_positives < min_train:
        log(
            f"WARNING: Gate A not met — {train_positives} train positives "
            f"< {min_train}. Add another Roboflow dataset (or more local positives) "
            f"to the config and re-run."
        )
        summary["gate_a_passed"] = False
    else:
        log(f"Gate A passed: {train_positives} >= {min_train} train positives.")
        summary["gate_a_passed"] = True

    print("BUILD_SUMMARY:" + json.dumps(summary))
    return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("config", type=Path, help="path to pets/<pet>.yaml")
    args = ap.parse_args()
    cfg = load_config(args.config)
    build(cfg)


if __name__ == "__main__":
    main()
