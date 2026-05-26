#!/usr/bin/env python3
"""Phases B + C — train YOLOv9, export a Frigate-compatible ONNX, validate it.

Config-driven (see pets/_template.yaml). Run AFTER build_dataset.py.

Phase B  — `yolo detect train` on device=mps (Apple Silicon) at imgsz=320.
Gate B   — val mAP50 >= gates.min_map50 (default 0.85). Below: the caller should
           bump base_model to yolov9s.pt / raise epochs and re-run (we log it).
Phase C  — `yolo export format=onnx nms=False simplify=True` (mandatory: NO
           embedded NMS, post-sigmoid scores — Ultralytics detect export is).
Gate C   — onnx.checker passes AND no EfficientNMS_TRT / NonMaxSuppression node
           AND input is [1,3,imgsz,imgsz]. Otherwise STOP (broken in Frigate).

Prints, at the end:
  - final val mAP50 / mAP50-95
  - the validated .onnx path
  - a ready-to-paste Frigate model:/objects: snippet + the 1-line labelmap.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import yaml


def log(msg: str) -> None:
    print(f"[train_export] {msg}", flush=True)


def load_config(path: Path) -> dict:
    with open(path) as fh:
        return yaml.safe_load(fh)


def find_data_yaml(work_dir: Path) -> Path:
    p = work_dir / "dataset" / "data.yaml"
    if not p.exists():
        sys.exit(f"FATAL: {p} not found — run build_dataset.py first.")
    return p


def train(cfg: dict, work_dir: Path, data_yaml: Path) -> tuple[Path, dict]:
    from ultralytics import YOLO

    base_model = cfg.get("base_model", "yolov9t.pt")
    imgsz = int(cfg.get("imgsz", 320))
    epochs = int(cfg.get("epochs", 120))
    batch = int(cfg.get("batch", 32))
    patience = int(cfg.get("patience", 30))
    device = cfg.get("device", "mps")
    run_name = f"{cfg['class_name']}_y9"
    runs_dir = work_dir / "runs"

    # Optional domain augmentation (docs/HAMSTER_MODEL_TUNING.md Phase I). Any keys
    # under `augment:` in the pet YAML are forwarded verbatim to Ultralytics
    # model.train(); the core args below win on conflict (setdefault).
    aug = cfg.get("augment") or {}
    if not isinstance(aug, dict):
        sys.exit("FATAL: config 'augment' must be a mapping of Ultralytics train args.")

    log(
        f"training {base_model} imgsz={imgsz} epochs={epochs} batch={batch} "
        f"device={device} -> {runs_dir}/{run_name}"
    )
    if aug:
        log(f"augmentation overrides: {aug}")
    model = YOLO(base_model)
    train_kwargs = dict(
        data=str(data_yaml),
        imgsz=imgsz,
        epochs=epochs,
        batch=batch,
        device=device,
        patience=patience,
        project=str(runs_dir),
        name=run_name,
        exist_ok=True,
    )
    for k, v in aug.items():
        train_kwargs.setdefault(k, v)
    results = model.train(**train_kwargs)

    best = runs_dir / run_name / "weights" / "best.pt"
    if not best.exists():
        sys.exit(f"FATAL: training produced no best.pt at {best}")

    # Pull final val metrics. results.results_dict has the metrics/* keys.
    metrics = {}
    try:
        rd = getattr(results, "results_dict", {}) or {}
        metrics = {
            "map50": float(rd.get("metrics/mAP50(B)", 0.0)),
            "map50_95": float(rd.get("metrics/mAP50-95(B)", 0.0)),
        }
    except Exception:  # noqa: BLE001
        pass
    # Fallback: re-run val on best.pt if metrics came back empty.
    if not metrics.get("map50"):
        log("re-validating best.pt to capture mAP ...")
        v = YOLO(str(best)).val(data=str(data_yaml), imgsz=imgsz, device=device)
        metrics = {"map50": float(v.box.map50), "map50_95": float(v.box.map)}

    log(f"final val mAP50={metrics['map50']:.4f}  mAP50-95={metrics['map50_95']:.4f}")

    min_map = float(cfg.get("gates", {}).get("min_map50", 0.85))
    if metrics["map50"] < min_map:
        log(
            f"WARNING: Gate B NOT met — mAP50 {metrics['map50']:.4f} < {min_map}. "
            f"Bump base_model to yolov9s.pt and/or raise epochs in the config, "
            f"then re-run. (Proceeding to export so you can still inspect it.)"
        )
        metrics["gate_b_passed"] = False
    else:
        log(f"Gate B passed: mAP50 {metrics['map50']:.4f} >= {min_map}.")
        metrics["gate_b_passed"] = True

    return best, metrics


def export_onnx(cfg: dict, best: Path, work_dir: Path) -> Path:
    from ultralytics import YOLO

    imgsz = int(cfg.get("imgsz", 320))
    log(f"exporting {best.name} -> ONNX (imgsz={imgsz}, nms=False, simplify=True)")
    model = YOLO(str(best))
    onnx_path = model.export(
        format="onnx",
        imgsz=imgsz,
        opset=12,
        nms=False,        # MANDATORY — no EfficientNMS_TRT for Frigate yolo-generic
        simplify=True,
        dynamic=False,
    )
    onnx_path = Path(onnx_path)

    # Park a stable, descriptively named copy next to the dataset.
    final = work_dir / f"{cfg['class_name']}_y9.onnx"
    shutil.copy2(onnx_path, final)
    log(f"exported ONNX -> {final}")
    return final


def validate_onnx(onnx_path: Path, imgsz: int) -> dict:
    """Phase C.3 — onnx.checker, NO NMS node, input [1,3,imgsz,imgsz]."""
    import onnx

    m = onnx.load(str(onnx_path))
    onnx.checker.check_model(m)

    ops = {n.op_type for n in m.graph.node}
    nms_nodes = {"EfficientNMS_TRT", "NonMaxSuppression"} & ops
    if nms_nodes:
        sys.exit(
            f"FATAL Gate C: ONNX contains NMS node(s) {nms_nodes} — this breaks "
            f"Frigate's yolo-generic decoder. Re-export with nms=False, or fall "
            f"back to the YOLO-NAS export path (model_type: yolonas)."
        )

    def shape(t):
        return [d.dim_value for d in t.type.tensor_type.shape.dim]

    inputs = [(i.name, shape(i)) for i in m.graph.input]
    outputs = [(o.name, shape(o)) for o in m.graph.output]
    opset = m.opset_import[0].version

    expect = [1, 3, imgsz, imgsz]
    if not inputs or inputs[0][1] != expect:
        sys.exit(
            f"FATAL Gate C: input shape {inputs[0][1] if inputs else None} "
            f"!= expected {expect}."
        )

    log(f"ONNX inputs : {inputs}")
    log(f"ONNX outputs: {outputs}")
    log(f"Gate C passed: checker OK, no NMS node, input {expect}, opset {opset}.")
    return {"inputs": inputs, "outputs": outputs, "opset": opset, "no_nms": True}


def frigate_snippet(cfg: dict, onnx_basename: str, labelmap_basename: str) -> str:
    cls = cfg["class_name"]
    imgsz = int(cfg.get("imgsz", 320))
    min_score = cfg.get("frigate", {}).get("min_score", 0.50)
    threshold = cfg.get("frigate", {}).get("threshold", 0.60)
    return f"""# ---- paste into mac-mini/frigate-config.yml ----
model:
  model_type: yolo-generic
  width: {imgsz}
  height: {imgsz}
  input_tensor: nchw
  input_dtype: float
  path: /config/model_cache/{onnx_basename}
  labelmap_path: /config/model_cache/{labelmap_basename}

objects:
  track: [{cls}]
  filters:
    {cls}: {{ min_score: {min_score}, threshold: {threshold} }}

# Apply the same `objects:` block to each per-camera block too.
# labelmap file ({labelmap_basename}) is a single line:
#   {cls}
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("config", type=Path)
    ap.add_argument(
        "--skip-train",
        action="store_true",
        help="export+validate an existing best.pt without retraining",
    )
    args = ap.parse_args()
    cfg = load_config(args.config)
    work_dir = Path(os.path.expanduser(cfg["work_dir"]))
    imgsz = int(cfg.get("imgsz", 320))

    if args.skip_train:
        best = work_dir / "runs" / f"{cfg['class_name']}_y9" / "weights" / "best.pt"
        if not best.exists():
            sys.exit(f"FATAL: --skip-train but no weights at {best}")
        metrics = {"map50": None, "map50_95": None, "gate_b_passed": None}
    else:
        data_yaml = find_data_yaml(work_dir)
        best, metrics = train(cfg, work_dir, data_yaml)

    onnx_path = export_onnx(cfg, best, work_dir)
    val = validate_onnx(onnx_path, imgsz)

    labelmap = work_dir / f"{cfg['class_name']}.txt"
    labelmap.write_text(f"{cfg['class_name']}\n")

    summary = {
        "best_weights": str(best),
        "onnx_path": str(onnx_path),
        "labelmap_path": str(labelmap),
        "metrics": metrics,
        "onnx_validation": val,
    }

    print("\n" + "=" * 70)
    print("PIPELINE COMPLETE")
    print("=" * 70)
    if metrics.get("map50") is not None:
        print(f"  final val mAP50    : {metrics['map50']:.4f}")
        print(f"  final val mAP50-95 : {metrics['map50_95']:.4f}")
        print(f"  Gate B (>=0.85)    : {'PASS' if metrics['gate_b_passed'] else 'FAIL'}")
    print(f"  validated ONNX     : {onnx_path}")
    print(f"  Gate C (no-NMS)    : PASS")
    print(f"  labelmap           : {labelmap}")
    print()
    print(frigate_snippet(cfg, onnx_path.name, labelmap.name))
    print("TRAIN_EXPORT_SUMMARY:" + json.dumps(summary))


if __name__ == "__main__":
    main()
