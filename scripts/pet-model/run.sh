#!/usr/bin/env bash
#
# Reusable, config-driven pet-detection training pipeline for Frigate.
#
# Usage:
#   export ROBOFLOW_API_KEY=rf_xxx
#   scripts/pet-model/run.sh scripts/pet-model/pets/hamster.yaml
#
# Does (all phases from docs/HAMSTER_MODEL_PLAN.md):
#   A. setup venv (outside the repo) + install deps
#   A. download Roboflow datasets, merge -> single class -> dedupe -> 80/20 split
#   B. train YOLOv9 on device=mps
#   C. export Frigate-compatible ONNX (nms=False) + validate (no-NMS, [1,3,320,320])
#   prints final mAP, validated .onnx path, and a paste-ready Frigate snippet.
#
# Idempotent: reuses an existing venv and cached dataset downloads. All large
# artifacts (venv/datasets/runs/weights/onnx) live under the config's work_dir,
# which MUST be outside the git repo. The Roboflow key is read from the env ONLY.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONFIG="${1:-}"
if [[ -z "$CONFIG" ]]; then
  echo "usage: $0 <pet-config.yaml> [--skip-train]" >&2
  echo "  e.g. $0 ${SCRIPT_DIR}/pets/hamster.yaml" >&2
  exit 2
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "FATAL: config not found: $CONFIG" >&2
  exit 2
fi
SKIP_TRAIN="${2:-}"

if [[ -z "${ROBOFLOW_API_KEY:-}" ]]; then
  echo "FATAL: ROBOFLOW_API_KEY is not set. Run: export ROBOFLOW_API_KEY=rf_xxx" >&2
  exit 1
fi

# --- resolve work_dir from the config (pure bash — no system-python/pyyaml dep,
#     since the venv that has pyyaml doesn't exist yet at this point) ---
WORK_DIR="$(sed -n 's/^work_dir:[[:space:]]*//p' "$CONFIG" | head -1 \
  | sed 's/[[:space:]]*#.*$//' | tr -d "\"'" | tr -d '[:space:]')"
WORK_DIR="${WORK_DIR/#\~/$HOME}"   # expand a leading ~
if [[ -z "$WORK_DIR" ]]; then
  echo "FATAL: could not read 'work_dir:' from $CONFIG" >&2
  exit 1
fi
echo "[run] work_dir = $WORK_DIR"
mkdir -p "$WORK_DIR"

# --- guard: work_dir must be OUTSIDE the repo (no datasets/weights in git) ---
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
case "$(cd "$WORK_DIR" && pwd)" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    echo "FATAL: work_dir ($WORK_DIR) is inside the repo ($REPO_ROOT)." >&2
    echo "       Point work_dir at e.g. ~/pet-models/<pet> so artifacts stay out of git." >&2
    exit 1 ;;
esac

LOG="$WORK_DIR/pipeline.log"
echo "[run] logging to $LOG"

# --- Phase A.0 — venv + deps (idempotent) ---
VENV="$WORK_DIR/.venv"
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "[run] creating venv at $VENV"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

if [[ ! -f "$VENV/.deps-installed" ]]; then
  echo "[run] installing deps (ultralytics, roboflow, onnx, onnxruntime, onnxslim, pyyaml)"
  pip install --upgrade pip >>"$LOG" 2>&1
  pip install "ultralytics>=8.3" roboflow onnx onnxruntime onnxslim pyyaml >>"$LOG" 2>&1
  touch "$VENV/.deps-installed"
else
  echo "[run] deps already installed (delete $VENV/.deps-installed to force reinstall)"
fi

# --- Phase A — build dataset (skip if only re-exporting) ---
if [[ "$SKIP_TRAIN" != "--skip-train" ]]; then
  echo "[run] Phase A — build_dataset.py"
  python3 "$SCRIPT_DIR/build_dataset.py" "$CONFIG" 2>&1 | tee -a "$LOG"
fi

# --- Phases B + C — train, export, validate ---
echo "[run] Phases B+C — train_export.py"
if [[ "$SKIP_TRAIN" == "--skip-train" ]]; then
  python3 "$SCRIPT_DIR/train_export.py" "$CONFIG" --skip-train 2>&1 | tee -a "$LOG"
else
  python3 "$SCRIPT_DIR/train_export.py" "$CONFIG" 2>&1 | tee -a "$LOG"
fi

echo "[run] done. Full log: $LOG"
