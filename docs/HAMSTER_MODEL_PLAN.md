# Custom hamster detection model for Frigate — agent-executable runbook

**Goal:** replace the stock COCO detector (which has **no rodent class** — `mouse`
in COCO is a *computer mouse*, so the cage is currently matched against a
computer-mouse + cat detector at a hacked-down `min_score`) with a **1-class
`hamster` model** running on the Mac Mini's Intel UHD 630 via Frigate's OpenVINO
detector. Better detection = reliable zone/diary activities.

This is written so a Claude agent (Bash + web + the repo + SSH to the host) can
execute it end to end. Steps that genuinely need a human are flagged
**[HUMAN]**; everything else is autonomous.

---

## 0. What a human must provide (one-time)

1. **[HUMAN] A free Roboflow account + API key** → the agent uses it to pull
   datasets. Export it before running: `export ROBOFLOW_API_KEY=rf_xxx`.
2. **[HUMAN] Green-light local training compute.** Training runs on the dev Mac
   (Apple Silicon, MPS). Budget ~30–90 min, ~5 GB disk, Python 3.11+. No cloud
   GPU or paid service required.
3. **[HUMAN] Final visual sign-off** at the end (does it actually box the hamster
   in the live debug view). Everything up to that is automated.

Nothing else is manual — the public datasets are **already labeled**, so Phase A
needs no box-drawing.

## 1. Hard constraints (bake these in or it won't load in Frigate)

| Constraint | Value |
|---|---|
| Detector | `openvino`, `device: GPU` (UHD 630) |
| Model file | **ONNX** (`.onnx`) — OpenVINO converts internally |
| `model_type` | `yolo-generic` (YOLOv9) |
| Input | `width: 320`, `height: 320`, `input_tensor: nchw`, `input_dtype: float` |
| Output | **sigmoid-normalized scores, NO embedded NMS** (`EfficientNMS_TRT` ⇒ broken) |
| Classes | `1` (`hamster`) with a matching 1-line labelmap |

The export step (Phase C) is the **highest-risk** part — validate the ONNX
before shipping (Phase C.3).

## 2. Dataset review (Roboflow Universe, `class:hamster`)

The agent verifies exact counts/licenses on download; approximate from review:

| Dataset (Universe slug) | ~Images | Notes |
|---|---|---|
| `hamsterhams/hamsters-vohzn` | ~223 | Largest single set; pre-trained model + API exists |
| `nathan-cqd2g/hamster-detection` | ~112 | Pre-trained model, reports high mAP (validate — small set) |
| `test-pq3k6/hamster-0ip1u` | ~100 | YOLOv8-format, hosted API |
| `rat01/hamster-xqr4j` | ~? (2024) | Newer; multiple YOLO export versions |
| `home-d7ggv/hamster-lc08s` | ~? | Older (2022) |

**Strategy:** the high mAP numbers reported on individual sets are on *their* held-out
images and won't transfer to your cage. So **merge the 3 largest** (`hamsterhams`
+ `nathan` + `test` ≈ 400+ images), de-dupe, normalize every label to a single
`hamster` class, and treat this as the **public baseline**. If it under-performs
on your actual cage (Phase E), Phase F fine-tunes on your own snapshots.

## 3. Phase A — Build the dataset (autonomous)

Working dir: `~/hamster-model/` (outside the repo).

```sh
python3 -m venv ~/hamster-model/.venv && source ~/hamster-model/.venv/bin/activate
pip install "ultralytics>=8.3" roboflow onnx onnxruntime onnxslim
```

For each chosen dataset, download in YOLOv8 format via the Roboflow SDK
(`rf.workspace(...).project(...).version(N).download("yolov8")`), then a prep
script: merge images/labels, **remap all class IDs to 0 (`hamster`)**, drop
duplicates (hash), and write a unified `data.yaml` with `nc: 1`, `names: [hamster]`
and an 80/20 train/val split. Output: `~/hamster-model/dataset/`.

**Gate A:** ≥ ~350 usable train images and a non-empty val split, every label
class == 0. If not, add another Universe set and re-run.

## 4. Phase B — Train YOLOv9 (autonomous, dev Mac MPS)

```sh
yolo detect train model=yolov9t.pt data=~/hamster-model/dataset/data.yaml \
  imgsz=320 epochs=120 batch=32 device=mps patience=30 \
  project=~/hamster-model/runs name=hamster_y9
```

- `yolov9t` (tiny) keeps iGPU inference cheap; bump to `yolov9s` if mAP is weak.
- Run in the background; poll `runs/hamster_y9/results.csv`.
- **Gate B:** `metrics/mAP50(B) ≥ 0.85` on val. Below that, raise epochs / switch
  to `yolov9s` / add data, then re-train. Best weights: `runs/hamster_y9/weights/best.pt`.

## 5. Phase C — Export a Frigate-compatible ONNX (autonomous, the risky step)

```sh
yolo export model=~/hamster-model/runs/hamster_y9/weights/best.pt \
  format=onnx imgsz=320 opset=12 nms=False simplify=True
```

**C.1** `nms=False` is mandatory (no `EfficientNMS_TRT`). **C.2** confirm the
classification head is post-sigmoid (Ultralytics detection export is). **C.3 —
validate before shipping:**

```sh
python3 - <<'PY'
import onnx
m = onnx.load("best.onnx"); onnx.checker.check_model(m)
ops = {n.op_type for n in m.graph.node}
assert not ({"EfficientNMS_TRT","NonMaxSuppression"} & ops), f"NMS node present: {ops & {'EfficientNMS_TRT','NonMaxSuppression'}}"
print("inputs :", [(i.name, [d.dim_value for d in i.type.tensor_type.shape.dim]) for i in m.graph.input])
print("outputs:", [(o.name, [d.dim_value for d in o.type.tensor_type.shape.dim]) for o in m.graph.output])
print("OK — no NMS, opset", m.opset_import[0].version)
PY
```

Expect input `[1,3,320,320]` and a single concatenated detection output. Cross-check
the layout against Frigate's `yolo-generic` decoder (ref: Frigate Discussion
#19970 — known-good YOLOv9 ONNX export). **Gate C:** checker passes AND no NMS node.

## 6. Phase D — Deploy to Frigate (autonomous, via repo + SSH)

1. **Labelmap** — `mac-mini/models/hamster.txt` (single line: `hamster`).
2. **Ship the model** to the host model cache:
   `scp best.onnx YOUR_USERNAME@project-server:/opt/hamster-cam/storage/model_cache/hamster_y9.onnx`
   (mount it into Frigate at `/config/model_cache/` — add the bind-mount + the
   labelmap mount in `mac-mini/docker-compose.yml` if not already mapped).
3. **Edit `mac-mini/frigate-config.yml`:**
   ```yaml
   model:
     model_type: yolo-generic
     width: 320
     height: 320
     input_tensor: nchw
     input_dtype: float
     path: /config/model_cache/hamster_y9.onnx
     labelmap_path: /config/model_cache/hamster.txt
   objects:
     track: [hamster]          # was [mouse, cat]
     filters:
       hamster: { min_score: 0.5, threshold: 0.6 }   # real class ⇒ raise from 0.30
   ```
   Update both `hamster_cam_1` / `hamster_cam_2` per-camera `objects` blocks the
   same way. Keep `detectors.ov` (`openvino`, `device: GPU`).
4. **Deploy:** `./deploy.sh --sync-frigate-config` (backs up the remote first) +
   ship the model, then `ssh YOUR_USERNAME@project-server 'cd /opt/hamster-cam && docker compose restart frigate'`.

## 7. Phase E — Verify (autonomous checks + one [HUMAN] look)

- **Frigate up & inferring:** `docker logs hamster-frigate` shows no model-load
  error; `GET :5000/api/stats` → `detectors.ov.inference_speed` reasonable
  (~10–25 ms on UHD 630) and per-camera `detection_fps > 0` when the hamster moves.
- **Detections fire:** trigger motion; Frigate events/debug show a `hamster` box
  at a sane score. App diary shows zone activities again.
- **[HUMAN]** eyeball the Frigate debug view: the box tracks the hamster, few
  false positives. Tune `min_score`/`threshold` if needed.

**Gate E (acceptance):** hamster reliably detected in the live cage at the chosen
threshold across day/night lighting.

## 8. Phase F — (optional) fine-tune on YOUR cage (semi-autonomous)

If Gate E is weak (others' hamsters/cages ≠ yours): the agent pulls 150–300
snapshots from the host (`/opt/hamster-cam/storage/frigate` or Frigate's snapshot
API), **auto-labels** them with the Phase-B model, **[HUMAN]** quick-reviews the
boxes in Roboflow, then re-runs Phase B–D with the combined set. This is the
single biggest accuracy lever and usually only needed once.

## 9. Rollback

Frigate config is host-authoritative and backed up by `--sync-frigate-config`.
To revert: restore the latest `frigate-config.yml.bak-*` (or `git checkout` the
`model:`/`objects:` blocks back to `ssdlite_mobilenet_v2` + `track: [mouse, cat]`)
and `docker compose restart frigate`.

## 10. Risk register / decision gates

| Risk | Mitigation |
|---|---|
| **ONNX incompatible with Frigate OpenVINO** (NaNs / bad scores) | `nms=False`, validate in C.3, follow the known-good YOLOv9 export; if it still fails, fall back to **YOLO-NAS** (`model_type: yolonas`) export path |
| Public datasets don't generalize to your cage | Phase F fine-tune on own snapshots |
| Weak mAP | Gate B: bump to `yolov9s` / more epochs / more data |
| iGPU too slow at 320 | drop to `yolov9t`; 320×320 on UHD 630 is well within budget |
| Roboflow license terms | agent records each dataset's license; all listed are public/CC — verify before redistribution (we don't redistribute, just train) |

## How to run this

Hand this file to an agent with: a `ROBOFLOW_API_KEY`, Bash on the dev Mac, and
SSH to `YOUR_USERNAME@project-server`. It executes Phases A→E autonomously, pausing
only at the **[HUMAN]** gates (API key up front, final visual sign-off, and the
optional Phase F label review).
