# `pet-model` — config-driven pet-detection training for Frigate

A reusable pipeline that turns one or more **Roboflow Universe** datasets into a
single-class detector ONNX that loads in **Frigate** (OpenVINO, `yolo-generic`,
320×320). The whole process is parameterized by a per-pet YAML — you adapt it to
a new animal by editing a config, **not** the code.

It implements Phases A–C of [`docs/HAMSTER_MODEL_PLAN.md`](../../docs/HAMSTER_MODEL_PLAN.md):
download + merge + remap-to-one-class + dedupe + 80/20 split → train YOLOv9 on
`device=mps` → export a Frigate-safe ONNX (`nms=False`) → validate it (onnx.checker,
**no** `EfficientNMS_TRT`/`NonMaxSuppression`, input `[1,3,320,320]`).

It stops at a **validated `.onnx` + a paste-ready Frigate config snippet**. It does
NOT deploy — the human gates the live cutover.

## Files

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator: venv setup, deps, then runs the two Python phases. Idempotent + logged. |
| `build_dataset.py` | Phase A: download Roboflow sets, merge → class 0 → dedupe → split → `data.yaml`. |
| `train_export.py` | Phases B+C: train YOLOv9, export ONNX (`nms=False`), validate, print Frigate snippet. |
| `pets/hamster.yaml` | The hamster config (3 merged datasets). |
| `pets/_template.yaml` | Copy this to make a config for a new pet. |

## Prerequisites

- A free **Roboflow** account + API key. The pipeline reads it from the
  environment **only** and fails with a clear message if unset. **Never** put the
  key in a config, file, or commit.
- Python 3.11+ (3.11/3.12 recommended — `torch`/`ultralytics` wheels may lag on
  the newest releases). ~5 GB free disk, ~30–90 min on Apple Silicon (MPS).

## Run it

```sh
export ROBOFLOW_API_KEY=rf_xxxxxxxx          # never written to disk by the pipeline
./scripts/pet-model/run.sh scripts/pet-model/pets/hamster.yaml
```

What you get at the end (printed + in `<work_dir>/pipeline.log`):

- final val **mAP50 / mAP50-95**,
- the validated `<work_dir>/<pet>_y9.onnx` path (passed the no-NMS / sigmoid /
  `[1,3,320,320]` checks),
- the 1-line labelmap path,
- a ready-to-paste Frigate `model:` / `objects:` snippet.

All large artifacts (venv, datasets, training runs, weights, ONNX) land under the
config's `work_dir` (default `~/pet-models/<pet>/`), which the wrapper **refuses
to place inside the git repo**. Nothing heavy is committed.

### Mixing in your own frames (local sources)

Beyond Roboflow, the build step can fold in **local image dirs** you harvested
yourself (e.g. real frames pulled off the live Frigate host) — this is the single
biggest accuracy lever for a specific cage. Add a `local_sources:` list to the pet
config:

```yaml
local_sources:
  - path: ~/pet-models/hamster/local/cage_pos   # images/ + labels/ (YOLOv8 layout)
    role: positive
  - path: ~/pet-models/hamster/local/cage_neg   # images/ only
    role: negative
local_oversample: 4    # duplicate local samples Nx in TRAIN (val untouched)
```

- **`role: positive`** — `images/` + `labels/`; labels are remapped to class 0 like
  any other source.
- **`role: negative`** — `images/` only; each image is emitted as a YOLO **background**
  example (empty label) so the model learns **not** to fire on reflections, glints,
  and empty-cage frames. Keep negatives to ≲30–40% of positives.
- **`local_oversample`** — local frames are usually far outnumbered by public images;
  this duplicates them in the **train** split only (val is never oversampled, so mAP
  stays honest). `1` = off; try `3–5` once you have cage frames.

Local sources are de-duped (content hash) against the Roboflow merge and each other,
and spread across the train/val split deterministically. With **no** `local_sources`
configured the output is identical to the Roboflow-only build. See
[`docs/HAMSTER_MODEL_TUNING.md`](../../docs/HAMSTER_MODEL_TUNING.md) Phases F–H for the
full harvest → review → fine-tune workflow.

### Re-export without retraining

```sh
./scripts/pet-model/run.sh scripts/pet-model/pets/hamster.yaml --skip-train
```

### Gates the pipeline enforces (from the runbook)

| Gate | Check | If it fails |
|---|---|---|
| **A** | ≥ `gates.min_train_images` (350) train images | logs a warning; add another dataset to the config + re-run |
| **B** | val `mAP50 ≥ gates.min_map50` (0.85) | logs a warning; bump `base_model: yolov9s.pt` and/or raise `epochs`, re-run |
| **C** | onnx.checker passes, **no** NMS node, input `[1,3,320,320]` | **hard STOP** — a NMS-baked ONNX is broken in Frigate. Fall back to YOLO-NAS (see below). |

### Fallback if the YOLOv9 ONNX won't validate (Gate C)

`nms=False` on the Ultralytics detect export normally yields a Frigate-safe graph
(post-sigmoid scores, single concatenated output, no `EfficientNMS_TRT`). If your
`ultralytics`/`onnx` versions still emit an NMS node, the pipeline stops. Per the
runbook risk register, export a **YOLO-NAS** model instead and set Frigate's
`model_type: yolonas`. That is a separate export path; record the blocker and the
exact versions before switching.

---

## Adapting to a different pet (cat / dog / rabbit / …)

The pipeline itself is species-agnostic. To target a new pet:

### 1. Find Roboflow datasets for the species

Browse `https://universe.roboflow.com/search?q=class:<pet>` (e.g. `class:cat`).
For each dataset you want: open it → **Download Dataset** → format **YOLOv8** →
read the snippet `rf.workspace("<ws>").project("<proj>").version(<N>)`. The
`<ws>`, `<proj>`, `<N>` are exactly what go in the config. Prefer 2–4 sets so the
merge generalizes; the pipeline dedupes exact-duplicate images across them and
collapses **all** their labels to a single class, so mixed/multi-class upstream
sets are fine.

### 2. Write the pet config

```sh
cp scripts/pet-model/pets/_template.yaml scripts/pet-model/pets/cat.yaml
$EDITOR scripts/pet-model/pets/cat.yaml
```

Set `class_name: cat`, `work_dir: ~/pet-models/cat`, the `datasets:` list, and
(optionally) `frigate.min_score`/`threshold`. Keep `imgsz: 320` and
`base_model: yolov9t.pt` unless Gate B is weak.

### 3. Run it

```sh
export ROBOFLOW_API_KEY=rf_xxx
./scripts/pet-model/run.sh scripts/pet-model/pets/cat.yaml
```

### 4. Frigate-side changes (the deploy, gated by a human)

This pipeline stops at the validated ONNX. To deploy (do this yourself), in
`mac-mini/frigate-config.yml`:

1. **Ship the model + labelmap** into Frigate's model cache (e.g.
   `/config/model_cache/cat_y9.onnx` and `cat.txt`) and bind-mount it (see
   `docs/HAMSTER_MODEL_PLAN.md` §6). The labelmap is a **single-line file**:
   ```
   cat
   ```
2. **`model:`** block — point `path` at the ONNX, `labelmap_path` at the labelmap,
   `model_type: yolo-generic`, `width/height: 320`, `input_tensor: nchw`,
   `input_dtype: float`. (The pipeline prints this block for you.)
3. **`objects:`** — set `track: [cat]` (was `[mouse, cat]`) and the per-class
   `filters: { cat: { min_score: ..., threshold: ... } }`. **Repeat the same
   `objects:` block inside each per-camera block** (`hamster_cam_1`,
   `hamster_cam_2`, …) — Frigate does not inherit it automatically there.

> ### ⚠️ The diary / zones are HAMSTER-CAGE-SPECIFIC — rethink them for another pet
>
> Swapping the detection model is **not** enough to make this stack meaningful for
> a non-hamster pet. The whole "diary" is built around a hamster cage's geometry
> and behaviours:
>
> - **Narrator zone keywords** — `matchKeyword` in
>   [`app/server/src/narrator.ts`](../../app/server/src/narrator.ts) maps zone-name
>   substrings to activities: `wheel`→running, `food`/`bowl`/`feed`→eating,
>   `water`/`drink`→drinking, `bathroom`/`potty`/`litter`/`toilet`→bathroom,
>   `bed`/`nest`/`sleep`/`rest`→resting, `tunnel`/`tube`/`pipe`→tunnel,
>   `hide`/`cave`/`burrow`→hiding, anything else→exploring. A **cat or dog has
>   different "activities"** (litter box, scratching post, couch, door, food/water
>   bowls, a yard) and a different environment — you'd rewrite these keyword→activity
>   mappings (and probably the activity enum + the narration copy) to match.
> - **The `zones:` blocks** in
>   [`mac-mini/frigate-config.yml`](../../mac-mini/frigate-config.yml) draw the
>   wheel/food/water/bathroom/bed/tunnel/hide regions over a *hamster cage*. For
>   another pet you re-draw zones over that animal's environment and name them so
>   they hit the (revised) narrator keywords.
> - Also note `wheel-odometer` logic the narrator triggers on the `wheel` activity
>   — meaningless for a cat/dog; drop or replace it.
>
> See **`docs/SETUP_MAC_MINI.md` §8.5 — "Define zones (these drive the diary)"**
> for the zone-editor workflow and the full keyword→activity table.
