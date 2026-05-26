# Tuning the hamster detector — agent-executable runbook (v2)

**Status of the model today:** a custom **1-class `hamster` YOLOv9-tiny** ONNX
(`hamster_y9.onnx`) is already trained, exported, and **live** on the Mac Mini's
Intel UHD 630 via Frigate's OpenVINO `yolo-generic` detector. The build pipeline
lives at [`scripts/pet-model/`](../scripts/pet-model/) and is config-driven +
idempotent. See [`HAMSTER_MODEL_PLAN.md`](./HAMSTER_MODEL_PLAN.md) for how v1 was
built (Phases A–E) and [`scripts/pet-model/README.md`](../scripts/pet-model/README.md)
for the pipeline contract.

**This document is the *tuning* runbook** — how to make the deployed model
recognise **Remy in Remy's actual cage** more reliably, day and night, without
chasing false positives. It is written so a Claude agent (Bash + web + the repo +
SSH to `omegaprime@project-server`) can execute it end to end. **[HUMAN]** flags
steps that genuinely need a person.

---

## 0. Why the current model can be beaten (the diagnosis)

The deployed model was trained **entirely on public Roboflow images** — strangers'
hamsters in strangers' cages, lit by strangers' lighting. Its reported `mAP50 ≥ 0.85`
gate was measured on a held-out slice of **those same public images**, *not* on
this cage. So the headline number tells us nothing about how it does on:

- **Remy specifically** (coat colour/markings/size the public sets under-represent),
- **this cage geometry** at the camera's ~45° angle, with the wheel, tunnel, hide,
  and glass front,
- **IR / low-light night frames** (06:00–22:00 is day; the night snapshot job runs
  22:00–06:00 — public daytime photos don't cover this),
- **reflections / glints / mains-flicker ripple** off the glass and water bowl,
  which currently have to be beaten back with conservative Frigate `min_score`/
  `threshold`/area/ratio filters instead of the model simply not firing on them.

Two levers close this gap, in priority order:

1. **Domain data — train on real cage frames.** *The single biggest lever.* Public
   data generalises the model; real cage frames specialise it to the only cage that
   matters. (Per the user: harvest only from **2026-05-25 19:00 local onward** — that
   is the first footage clean of the mains-flicker ripple fixed earlier that day;
   earlier frames would poison training with an artifact we've since eliminated.)
2. **More + better public data — broaden the base.** The v1 config used 3 sets
   (~435 imgs). Larger, more cage-like sets exist and are free.

Everything else (bigger backbone, augmentation, threshold re-tuning) is a multiplier
on top of those two — useful, but secondary, and **only measurable once we have a
real-cage eval set** (Phase J). *You cannot tune what you cannot measure.*

---

## 1. Hard constraints (unchanged from v1 — do not break these)

| Constraint | Value |
|---|---|
| Detector | `openvino`, `device: GPU` (UHD 630) |
| Model file | **ONNX**, `model_type: yolo-generic` |
| Input | `width/height: 320`, `input_tensor: nchw`, `input_dtype: float` |
| Output | sigmoid scores, **NO** embedded NMS (`EfficientNMS_TRT`/`NonMaxSuppression` ⇒ broken) |
| Classes | exactly `1` (`hamster`) + a 1-line labelmap |

`imgsz` stays **320**. Bumping it would help small-object recall but the iGPU
inference budget and the locked Frigate input shape make 320 the safe target. Revisit
only if `detectors.ov.inference_speed` has comfortable headroom *and* you re-measure.

---

## 2. The tuning levers, ranked

| # | Lever | Effort | Expected payoff | Where |
|---|---|---|---|---|
| 1 | **Fine-tune on harvested cage frames** (Phase G) | med | **highest** — closes the domain gap | new |
| 2 | **Hard-negative / background cage frames** (Phase H) | low-med | high — kills reflection/glint false positives at the *model*, lets us relax Frigate filters | new |
| 3 | **Add bigger public datasets** (Phase F) | low | medium — broadens the base, esp. the cage-cam set | config edit |
| 4 | **Real-cage held-out eval set** (Phase J) | med | *enables measuring everything else* | new |
| 5 | **Backbone + augmentation knobs** (Phase I) | low | small-medium | config edit |
| 6 | **Re-tune Frigate filters** after the model improves (Phase K) | low | recovers recall the conservative filters are currently sacrificing | `frigate-config.yml` |

Recommended order of execution: **F → (G + H + J harvest together) → I → train → J eval → K**.

---

## 3. Phase F — broaden the public base (config edit, autonomous)

The v1 config (`scripts/pet-model/pets/hamster.yaml`) merges 3 sets (~435 imgs).
Add these (confirm exact `version(N)` on each dataset's *Download → YOLOv8* snippet
before committing — the pipeline fails loudly on a wrong version):

| Universe slug | ~Images | Why it helps |
|---|---|---|
| `pet-monitor/hamster-k5ngx` | **~1521** | **Cage-/pet-monitor footage — the closest public domain match to our setup.** Biggest single set. |
| `guagua/hamster` | ~443 | Large, varied. |
| `tpicos-2-maurcio/hamster-and-guinea-pig` | ~188 | Multi-rodent; the pipeline remaps *all* labels → class 0, so guinea-pig boxes become extra "rodent-shaped" positives. Verify this doesn't add confusing non-hamster shapes; drop if it hurts Phase J. |
| `rat01/hamster-xqr4j` | ~75 | Newer (2024). |

> All four are **CC BY 4.0**. We only *train* on them (no redistribution). The
> pipeline records per-dataset counts in `BUILD_SUMMARY`. After adding, the merge +
> dedupe + 80/20 split is automatic — `build_dataset.py` needs **no code change** for
> this phase.

Edit `scripts/pet-model/pets/hamster.yaml` `datasets:` to append the chosen slugs.
**Gate A** (≥350 train imgs) will pass comfortably. Do **not** train yet — fold this
into the single combined train in §7.

---

## 4. Phase G — harvest real cage frames (the big lever) [HUMAN review]

### G.1 Pull frames from the live host (autonomous)
Frigate on `omegaprime@project-server` has been recording since go-live. Pull
**only events at/after `2026-05-25 19:00` local** (post-flicker-fix clean footage):

- **Preferred — event snapshots via the Frigate API** (already labelled-by-time,
  one clean frame per detection):
  ```sh
  # after= is a unix epoch; 2026-05-25 19:00 local. cameras filter to our two.
  AFTER=$(date -j -f '%Y-%m-%d %H:%M:%S' '2026-05-25 19:00:00' +%s)
  curl -s "http://127.0.0.1:5000/api/events?after=${AFTER}&cameras=hamster_cam_1,hamster_cam_2&has_snapshot=1&limit=1000" \
    | jq -r '.[].id' \
    | while read id; do
        curl -s "http://127.0.0.1:5000/api/events/${id}/snapshot.jpg?bbox=0&crop=0" \
          -o "harvest/pos/${id}.jpg"
      done
  ```
  Run this over SSH on the host (Frigate listens on the internal Docker network /
  `127.0.0.1:5000`) and `scp` the `harvest/` dir back to the dev Mac.
- **Also grab "no detection" frames for Phase H** — sample stills from the
  *recordings* (not events) at intervals: empty cage, reflections, glints, hamster
  fully inside hide/tunnel. These become **background negatives** (§5).
- **Cover the clock.** Deliberately include **night/IR** frames (22:00–06:00) and
  bright-day frames so the fine-tune sees both. Aim for **~200–400 positive frames**
  and **~100–200 negatives**, balanced across cam1/cam2 and across lighting.

> **Volume caveat:** harvesting from 2026-05-25 19:00 means data *accumulates over
> days*. If there aren't enough frames yet, this phase is **append-only** — let the
> cage record for several more days, re-pull, and re-run the combined train. The
> public data (Phase F) carries the model until the cage corpus is rich enough.

### G.2 Auto-label, then [HUMAN] review
1. **Auto-label** the positives with the *current* deployed `best.pt` (or pull the
   live ONNX) to pre-draw boxes:
   ```sh
   yolo detect predict model=~/pet-models/hamster/runs/hamster_y9/weights/best.pt \
     source=harvest/pos imgsz=320 conf=0.25 save_txt=True save_conf=False \
     project=harvest name=autolabel
   ```
2. **[HUMAN] quick-review the boxes.** Upload `harvest/pos` + the predicted labels
   to a free Roboflow project (or use `labelImg`/Label Studio locally) and **fix the
   boxes**: tighten loose ones, add the misses (sleeping/curled/partially-occluded
   Remy the model misses *today* are exactly the frames worth correcting), delete
   false boxes on reflections. This 20–40 min of human box-review is where the
   accuracy actually comes from.
3. Export the reviewed positives as **YOLOv8** into a local folder, e.g.
   `~/pet-models/hamster/local/cage_pos/{images,labels}`.

---

## 5. Phase H — hard negatives / background frames (kill false positives)

YOLO treats an image with **no label file (or an empty one)** as a *background*
example: "there is no hamster here — do not fire." Feeding the cage's own
reflections, water-bowl glints, cage-bar artifacts, and empty-cage stills as
backgrounds teaches the model to **not** call them hamsters — attacking the false
positives at the source instead of papering over them with Frigate `min_score`/
area/ratio filters.

- Put the §G.1 "no detection" stills into `~/pet-models/hamster/local/cage_neg/images`
  with **no** corresponding label files (or empty `.txt`).
- Keep negatives to **roughly ≤30–40% of positives** so the model doesn't collapse
  toward "never fire."

> **Pipeline change required (one-time):** `build_dataset.py` today only ingests
> Roboflow downloads and **skips any image whose remapped label is empty**
> (`skipped_unlabeled`). To use local cage data + negatives, extend it to also
> ingest configured **local source dirs** and to **keep label-less images as
> background** when a dir is marked `role: negative`. Concretely:
> 1. Add an optional `local_sources:` list to the pet YAML:
>    ```yaml
>    local_sources:
>      - path: ~/pet-models/hamster/local/cage_pos   # has images/ + labels/
>        role: positive
>      - path: ~/pet-models/hamster/local/cage_neg   # images/ only
>        role: negative
>    ```
> 2. In `build_dataset.py`: after the Roboflow merge, walk each `local_sources`
>    entry; for `positive`, pair images↔labels as usual; for `negative`, copy the
>    image and **emit an empty `.txt`** (don't `skipped_unlabeled`-drop it). Keep the
>    content-hash de-dupe and the deterministic split so cage frames spread across
>    train *and* val.
> 3. **Up-weight the cage data.** Public images outnumber cage images ~10:1; without
>    help the fine-tune barely moves toward our domain. Either duplicate cage
>    positives Nx into the train pool (simple), or stage it as a **two-stage train**
>    (pre-train on public, then fine-tune a few epochs on cage-only at a lower LR).
>    Start with the simple Nx duplication (e.g. 3–5x) and let Phase J judge it.

Keep this change small and config-driven — same ethos as the existing pipeline (the
Python should never need editing again for routine re-tunes).

---

## 6. Phase I — backbone & augmentation knobs (config edit)

Tune these in `scripts/pet-model/pets/hamster.yaml` for the combined train:

- **Backbone:** if Phase-J mAP on the *cage* set is weak, bump
  `base_model: yolov9t.pt → yolov9s.pt`. `s` roughly doubles capacity; re-check the
  iGPU `inference_speed` after deploy (should stay well under the 5 fps detect
  budget at 320). Keep `t` if `s` doesn't move the cage metric.
- **Epochs/patience:** with more data, `epochs: 120 → 150–200`, `patience: 30 → 50`.
- **Augmentation for *this* domain** (Ultralytics train args — wire them through
  `train_export.py`'s `model.train(...)` from new optional config keys):
  - `hsv_v: 0.5` (value/brightness jitter) and `hsv_s` — simulate the day↔night/IR
    range so the model is lighting-robust. **Highest-value aug for us.**
  - `degrees: 5–10`, `scale: 0.5`, `translate: 0.1` — small rotations/scale for the
    ~45° angle and Remy at varying distances.
  - `fliplr: 0.5` keep; **`flipud: 0.0`** — a hamster is never upside-down to the cam;
    vertical flips add nonsense.
  - `mosaic: 1.0` (default) is fine; consider `close_mosaic: 10` to disable it for the
    final epochs so the model sees realistic full frames at the end.

All of these are *optional config keys* — add them to the YAML and pass them through;
don't hardcode in the Python.

---

## 7. Phase — train the combined model (autonomous)

One combined run over **public (F) + cage positives (G) + cage negatives (H)** with
the (I) knobs:

```sh
export ROBOFLOW_API_KEY=rf_xxx
./scripts/pet-model/run.sh scripts/pet-model/pets/hamster.yaml
```

The pipeline downloads/merges public sets, folds in `local_sources`, trains, exports
the Frigate-safe ONNX, validates **Gate C** (no-NMS, `[1,3,320,320]`), and prints the
paste-ready Frigate snippet + labelmap. **Gate B** still reports mAP, but treat it as
secondary — the number that matters is **Phase J**.

---

## 8. Phase J — measure on a REAL-CAGE held-out set (the new gate)

Without this, "better recognition" is a vibe. Build it once:

1. From the §G harvest, **set aside ~60–120 reviewed cage frames** (mix of cam1/cam2,
   day/night, easy/occluded/sleeping) as a **held-out cage test set** — keep them
   **out** of train *and* val (a separate `data.yaml` `test:` split or a standalone
   folder). Never let these leak into training.
2. After each train, evaluate `best.pt` against the cage test set:
   ```sh
   yolo detect val model=.../best.pt data=cage_test.yaml imgsz=320 split=test
   ```
3. **Gate J (the real acceptance metric):** cage-test **mAP50 ≥ 0.80** *and* a
   visible drop in false positives on the negative frames vs. the current model.
   Record cage-test mAP50/mAP50-95 + a few annotated example frames in the PR.
   This is the number to optimise across Phases F–I — public mAP is just a sanity
   check.

---

## 9. Phase K — re-tune Frigate filters after the model improves (host)

The current `frigate-config.yml` filters are *deliberately conservative* to fight
reflections the v1 model fired on:
`min_score 0.55 / threshold 0.70 / min_area 1500 / max_area 80000 / min_ratio 0.4 /
max_ratio 2.2`. Once Phase H has taught the model to ignore glints, those filters are
over-tight and **cost real recall** (missed quick/partial appearances). After deploy:

1. Watch the Frigate debug view + events across a full day/night cycle.
2. If false positives stay low, **relax** toward the model's natural operating point:
   lower `threshold` (0.70 → ~0.60) and `min_score` (0.55 → ~0.50), and consider
   loosening `min_area`/ratios so the hamster-in-tunnel and quick zone-cross
   detections register (those drive the diary/zone activities and the wheel odometer).
3. Re-draw or finally **enable the commented-out object masks** only if a specific
   region still misbehaves — but prefer fixing it with negatives (Phase H) so masks
   don't blind a zone.
4. Apply identical `objects:` blocks to **both** per-camera blocks (Frigate doesn't
   inherit them per-camera) and deploy via
   `./deploy.sh --sync-frigate-config` + `docker compose restart frigate`.

---

## 10. Deploy, verify, version, rollback

- **Deploy** the new ONNX + labelmap exactly as v1 §6: `scp` to the host model cache
  (`/opt/hamster-cam/storage/model_cache/`), keep the bind-mount, restart Frigate.
- **Version the model** — *don't* overwrite the live file blind. Ship as
  `hamster_y9_vN.onnx` and flip `model.path` to it, so rollback is a one-line revert
  + restart. Keep the previous ONNX on the host.
- **Verify (autonomous):** `docker logs hamster-frigate` shows a clean model load;
  `GET :5000/api/stats` → `detectors.ov.inference_speed` sane (~10–25 ms) and
  per-camera `detection_fps > 0` on movement; app diary zone activities still fire.
- **[HUMAN] sign-off:** eyeball the debug view across day + night — the box tracks
  Remy through the wheel/tunnel/hide, few false fires.
- **Rollback:** restore the prior `hamster_y9_v{N-1}.onnx` path (or the latest
  `frigate-config.yml.bak-*`) and `docker compose restart frigate`.

---

## 11. Human gates (everything else is autonomous)

1. **[HUMAN]** `ROBOFLOW_API_KEY` exported (Phase F).
2. **[HUMAN]** SSH/host access to harvest frames (Phase G.1) — `omegaprime@project-server`.
3. **[HUMAN]** ~20–40 min box-review of harvested cage frames (Phase G.2) — *the work
   that actually buys the accuracy*.
4. **[HUMAN]** final visual sign-off on the live debug view (Phase 10).

## 12. Definition of done

A versioned, Frigate-validated ONNX that beats the current model on a **real-cage
held-out set** (Gate J: cage mAP50 ≥ 0.80 with fewer false positives), deployed with
the Frigate filters relaxed to recover the recall the conservative v1 settings were
sacrificing — verified live across a full day/night cycle.
