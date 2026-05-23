#!/usr/bin/env python3
"""Phase A — build a unified, single-class YOLO dataset from N Roboflow sets.

Config-driven: every parameter comes from a pet YAML (see pets/_template.yaml).
Reads ROBOFLOW_API_KEY from the environment (never from the config).

Steps:
  1. Download each configured Roboflow dataset in YOLOv8 format.
  2. Merge all images + labels into one pool.
  3. Remap every label's class id to 0 (the single `class_name`).
  4. De-dupe by image content hash (drops exact duplicates across datasets).
  5. 80/20 (configurable) train/val split.
  6. Write a unified data.yaml with nc: 1, names: [<class_name>].

Idempotent: re-running reuses already-downloaded Roboflow folders and rebuilds
the merged dataset from scratch each time (cheap, deterministic).

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

    # Collect (image_path, label_path) pairs across every dataset/split, dedupe.
    seen_hashes: set[str] = set()
    pairs: list[tuple[Path, Path]] = []
    skipped_dupes = 0
    skipped_unlabeled = 0
    per_dataset_counts: dict[str, int] = {}

    for ds_root in ds_paths:
        ds_name = ds_root.name
        count = 0
        for img_dir, lab_dir in iter_split_dirs(ds_root):
            for img in sorted(img_dir.iterdir()):
                if img.suffix.lower() not in {".jpg", ".jpeg", ".png", ".bmp"}:
                    continue
                label = lab_dir / (img.stem + ".txt")
                remapped = remap_label(label)
                if not remapped.strip():
                    skipped_unlabeled += 1
                    continue
                digest = file_hash(img)
                if digest in seen_hashes:
                    skipped_dupes += 1
                    continue
                seen_hashes.add(digest)
                pairs.append((img, label))
                count += 1
        per_dataset_counts[ds_name] = count

    if not pairs:
        sys.exit("FATAL: no labeled images found across the configured datasets.")

    # Deterministic shuffle + split.
    rng = random.Random(1337)
    rng.shuffle(pairs)
    val_frac = float(cfg.get("val_split", 0.20))
    n_val = max(1, int(len(pairs) * val_frac))
    val_pairs = pairs[:n_val]
    train_pairs = pairs[n_val:]

    def emit(pairs_list, split):
        for i, (img, label) in enumerate(pairs_list):
            # Unique flat names so cross-dataset collisions can't clobber.
            stem = f"{split}_{i:06d}"
            shutil.copy2(img, out_root / "images" / split / f"{stem}{img.suffix.lower()}")
            (out_root / "labels" / split / f"{stem}.txt").write_text(remap_label(label))

    emit(train_pairs, "train")
    emit(val_pairs, "val")

    data_yaml = {
        "path": str(out_root),
        "train": "images/train",
        "val": "images/val",
        "nc": 1,
        "names": [cfg["class_name"]],
    }
    (out_root / "data.yaml").write_text(yaml.safe_dump(data_yaml, sort_keys=False))

    summary = {
        "data_yaml": str(out_root / "data.yaml"),
        "train_images": len(train_pairs),
        "val_images": len(val_pairs),
        "total_images": len(pairs),
        "per_dataset_counts": per_dataset_counts,
        "skipped_duplicates": skipped_dupes,
        "skipped_unlabeled": skipped_unlabeled,
        "class_name": cfg["class_name"],
    }

    log(f"merged datasets: {per_dataset_counts}")
    log(
        f"train={summary['train_images']} val={summary['val_images']} "
        f"(dupes dropped={skipped_dupes}, unlabeled skipped={skipped_unlabeled})"
    )

    # Gate A — enough training data, every label class == 0 (guaranteed by remap).
    min_train = int(cfg.get("gates", {}).get("min_train_images", 350))
    if summary["train_images"] < min_train:
        log(
            f"WARNING: Gate A not met — {summary['train_images']} train images "
            f"< {min_train}. Add another Roboflow dataset to the config and re-run."
        )
        summary["gate_a_passed"] = False
    else:
        log(f"Gate A passed: {summary['train_images']} >= {min_train} train images.")
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
