# Hamster detector V4 — recall pass battle plan

**Companion to:** [`HAMSTER_MODEL_PLAN.md`](./HAMSTER_MODEL_PLAN.md) (v1 build) and
[`HAMSTER_MODEL_TUNING.md`](./HAMSTER_MODEL_TUNING.md) (the agent-executable
runbook the v3 precision pass was built from). This doc is V4-specific — read
the tuning runbook first if you're new to the pipeline.

> Last updated: 2026-05-29 · Author: Aaron + Claude (planning session)
> Status: **executing — Option C selected** (V4 trains at imgsz=480; the
> imgsz lever is bundled with the cage-data lever in a single deploy,
> accepting that a successful V4 won't cleanly attribute the win between
> the two — see §10.5).

---

## 1. Mission

V3 is live and doing the job we built it for: **precision**. It stopped firing
on the white bedding fluff and the wooden house (confirmed 0/200 FPs at conf
0.50 on the negative eval; 2 days of clean production since 2026-05-26).

The cost of that precision is recall — Frigate is still running at a
conservative `threshold: 0.65`, well above the v3 model's natural operating
point, and we don't yet know whether the live object masks are eating real
Remy tracks. V4 is the **recall pass**: catch the tunnel pokes, the partially
occluded sleepy curl-ups, and the quick wheel passes that V3 is currently
missing, without giving back any of the precision V3 earned.

**Acceptance:**

- Cage-test mAP50 **≥ 0.85** AND strictly **> V3's score** on the same
  held-out set.
- **0/200 false fires** on the V3 negative eval at the live operating point
  (conf ≥ 0.60).
- **Reflection-vs-live ranking**: on the held-out co-occurrence set
  (§2.5 — frames containing **both** Remy and his reflection), the live
  hamster's box scores **strictly higher** than the reflection's box on
  ≥ 95% of frames. V3 is currently failing this — see §1.2.5.
- Frigate threshold relaxed `0.65 → 0.60` (or 0.55 if precision holds at
  conf 0.55 in eval).
- Verified live across a full day/night cycle.

---

## 2. Current battlefield (verified 2026-05-28)

### Live Frigate filter state (`mac-mini/frigate-config.yml`)

| Setting | Live value | Notes |
|---|---|---|
| Global `objects.filters.hamster.min_score` | 0.55 | unchanged from v3 deploy |
| Global `objects.filters.hamster.threshold` | **0.65** | Phase K **partially applied** — was 0.80 at v3 deploy, lowered since |
| Per-camera `threshold` override | **removed** | both cams defer to global 0.65 |
| Per-camera `min_score` override | 0.5 (cam1 + cam2) | set **below** global 0.55 — see open question §10.1 |
| Object masks (cam1) | 3 polygons | cage edges + reflection-prone region |
| Object masks (cam2) | 4 polygons | cage edges + hide-side region |
| Zones (cam1) | wheel, food, water, tunnel | |
| Zones (cam2) | bathroom, wheel | cam2 **physically cannot see** bed/hide — see [`project_camera_fov`](../) memory; do **not** add zones to cam2 it can't see |

### Live model

- `/opt/hamster-cam/models/hamster_y9.onnx` = **V3** (deployed 2026-05-26
  ~20:47 UTC). Previous v1 backed up as `hamster_y9.prev.onnx`.
- Compose bind: `./models:/config/model_cache` (NOT `storage/model_cache` —
  the original runbook §10 had this wrong).
- Repo: V1/V2/V3 ONNX + .pt all parked under `models/hamster/v{1,2,3}/`
  (commit `c8472e5`, `.gitignore` exception in place).

### What was wrong in my first-pass plan (preserved here for the historical record)

- I read the live threshold as `0.80` — it's `0.65`. Phase K relax is
  half-done.
- I treated object masks as a footnote — they're 7 polygons covering real
  estate, and the `scripts/mask-audit/` tool was built precisely to verify
  they aren't eating tracks. **Mask audit is a hard gate, not a footnote.**
- I flagged missing `bed`/`hide` zones on cam2 as a gap — they're correctly
  absent (cam2 FoV doesn't cover those areas).

---

## 3. Pre-V4 inputs (data on hand)

### Positives

- **523 night cage positives** at `~/pet-models/hamster/local/cage_pos/` on
  the dev Mac, harvested 2026-05-25.
  - Auto-labeled with **v1** weights → labels contaminated by v1's
    fluff/house false fires.
  - **Must be re-auto-labeled with V3 weights and [HUMAN] reviewed** before
    use.
- **Daytime positives: not yet harvested.** Three full days of post-V3
  production footage exist on the host.

### Negatives

- **200 cage negatives** at `~/pet-models/hamster/local/cage_neg/` —
  reviewed, used in V3 training. Reused as-is in V4. V3 already enables them
  in `pets/hamster.yaml` `local_sources:`.

### Held-out test set

- **Does not exist yet.** Gate J in the V3 plan was a vibe — V3 was deployed
  on negative-eval + 200-frame precision check only. V4 will build the cage
  test set (Phase 2) **before** training.

---

## 4. Phase 0 — pre-flight (no model work)

**Owner: Claude + Aaron · Time: ~90 min · No model changes.**

### 0.1 Mask audit (MANDATORY GATE) — `scripts/mask-audit/`

The seven live mask polygons are doing real work. If any clip a real Remy
travel path, V4's extra recall gets eaten by Frigate before it ever shows up
as a detection — and we'd blame the wrong layer.

- [ ] On dev Mac, run `./scripts/mask-audit/audit.sh 48` (48h window).
- [ ] Open `scripts/mask-audit/out/index.html`.
- [ ] Eyeball every **orange-bordered tile** (short duration + low score).
      Cluster of orange along a red polygon edge → that mask is eating
      tracks.
- [ ] For any offending polygon: **shrink or delete it** (edit live config
      via Frigate UI; it writes the file back). Re-run audit to confirm.
- [ ] Commit `scripts/mask-audit/` to the repo — currently untracked.

**Exit criterion:** zero polygons confirmed to eat real tracks, OR the
offending polygons trimmed and re-verified.

### 0.2 V3-at-live-settings baseline capture

We need numbers V4 must beat. The numbers must be measured at the **current**
operating point, not the old 0.80 one.

- [ ] SSH `omegaprime@project-server`. Pull 48h of events:
      `curl -s "http://127.0.0.1:5000/api/events?after=$(date -d '-48 hours' +%s)&cameras=hamster_cam_1,hamster_cam_2&has_snapshot=1&limit=2000"`.
- [ ] Bucket events by `top_score`: counts in `[0.55, 0.65)`, `[0.65, 0.75)`,
      `[0.75, 0.85)`, `[0.85, 1.0]` per camera per day.
- [ ] Pull diary-entry counts per day from the SQLite DB (or app stats).
- [ ] Pull `detectors.ov.inference_speed`, per-camera `detection_fps`, and
      any model/onnx errors from `docker logs --tail=2000 hamster-frigate`.
- [ ] Stash all of the above to `docs/v4_baseline.txt` (committed). This is
      the **line in the sand**.

### 0.3 Resolve the per-camera vs global `min_score` ambiguity

Both global `min_score: 0.55` and per-cam `min_score: 0.5` exist. Frigate's
behaviour here is the operating point we need to reproduce in eval.

- [ ] Identify any live event with `0.50 ≤ top_score < 0.55`. If those
      exist → per-cam wins, effective floor is 0.5. If not → global wins,
      effective floor is 0.55.
- [ ] Document the answer in §10.1.
- [ ] **If per-cam is dead config**, decide whether to delete the per-cam
      `min_score: 0.5` lines (preferred — eliminates ambiguity) or align
      them to global. Folds into Phase 5 deploy diff.

---

## 5. Phase 1 — harvest (autonomous + [HUMAN] review)

**Owner: Claude (auto) + Aaron (box review) · Time: ~90 min auto + 30–60 min
HUMAN.**

> 🕒 **Harvest schedule decision (2026-05-29 evening, Aaron):**
> Phase 1.1 already harvested 671 frames using the existing 3-day
> window (2026-05-26 19:00 PDT onward), but the stack was unstable for
> the first 2 of those 3 days (cam2 URB crash storm, Pi swap, midstream
> hwaccel fix, fps bump, the whole reliability train). Only the
> 2026-05-29 day was on the post-everything steady state.
>
> **Defer the §1.5 night/IR harvest until after a full clean
> night-day-night cycle accumulates** — earliest fire 2026-05-31
> ~06:30 PDT. At that point Phase 1.1 should ALSO re-run with the
> wider window:
>
> - Phase 1.1 re-run: pull events from 2026-05-29 19:00 PDT onward,
>   replacing (not augmenting) the existing 671-frame harvest. The
>   pre-stable-stack frames are corpus-poisoning candidates for the
>   reasons in §1.2.6 (V3 detected the easy daytime cases, hardly
>   anything else).
> - §1.5 night/IR harvest: fire all four strategies fresh against the
>   clean 48h window.
> - The 671 frames already on the dev Mac at
>   `~/pet-models/hamster/harvest_v4/` can be kept for cross-reference
>   but should be moved out of the active review/ staging area so
>   they don't get re-labeled accidentally.
>
> While waiting (2026-05-29 evening → 2026-05-31 morning), useful
> human-gated work that doesn't depend on the harvest:
> - §0.1 mask audit visual review (HTML still pending at
>   `scripts/mask-audit/out/index.html`)
> - §0.3 per-cam `min_score` empirical answer
> - Opportunistic debug-view screen-captures of confirmed V3-failure
>   cases at night (drop into a `night_capture/` staging dir for
>   later import — Strategy 4 in §1.5).

### 1.1 Pull daytime + recent night events

Per `HAMSTER_MODEL_TUNING.md` §G.1 — but with **two changes vs V3**:

- **Auto-label with V3 weights**, not v1. V3 doesn't fire on fluff/house, so
  its pre-boxes are clean of those false fires.
- **Tag mask-overlapping frames.** If the audit (0.1) recommended shrinking
  any polygon, tag frames whose detection box falls inside the
  (pre-shrink) polygon — these are training-data gold (real Remy frames
  Frigate is currently discarding).

```sh
# On the host:
mkdir -p /tmp/harvest/{day,night}
AFTER_DAY=$(date -d '2026-05-26 07:00' +%s)
AFTER_NIGHT=$(date -d '2026-05-26 22:00' +%s)
for win in day night; do
  case $win in
    day)   A=$AFTER_DAY;;
    night) A=$AFTER_NIGHT;;
  esac
  curl -s "http://127.0.0.1:5000/api/events?after=${A}&cameras=hamster_cam_1,hamster_cam_2&has_snapshot=1&limit=2000" \
    | jq -r '.[].id' \
    | while read id; do
        curl -s "http://127.0.0.1:5000/api/events/${id}/snapshot.jpg?bbox=0&crop=0" \
          -o "/tmp/harvest/${win}/${id}.jpg"
      done
done
tar czf /tmp/harvest.tar.gz -C /tmp harvest
```

Then `scp` back to dev Mac under `~/pet-models/hamster/harvest/`.

**Target counts:**

- ~300–500 day positives (across cam1/cam2)
- Augment the existing 523 night positives with new night data (event
  recovery only — don't re-harvest the existing IDs)
- Balanced cam1/cam2 ratio

If short, **append-only** — let the cage record another day or two and
re-pull. Don't train hungry.

### 1.2 Auto-label with V3

```sh
yolo detect predict model=models/hamster/v3/best.pt \
  source=~/pet-models/hamster/harvest/day imgsz=320 conf=0.25 save_txt=True \
  project=~/pet-models/hamster/harvest name=autolabel_day
# repeat for /harvest/night
```

For the existing 523-frame `cage_pos/` set, **re-run V3 auto-label** on top —
don't trust the v1 labels still in that directory.

### 1.2.6 Known V3 failure mode — night/IR recall (severe across all activities, worst on the wheel)

**Symptom (observed in Frigate debug-view, 2026-05-29 evening):** V3
does not consistently detect — or hold detection on — Remy during
night/IR mode, **broadly, across all activities**. The failure
intensifies on the wheel but is present everywhere in the IR period.
This is a pure recall failure — V3 fires zero (or very low confidence)
on frames where the operator can clearly see the hamster in the
debug-view's raw stream.

**The data confirms it.** V3 fire-rate at conf 0.25 on the 671-frame
Phase 1.1 harvest:

| | Day | Night/IR |
|---|---|---|
| cam1 | 34% | **8%** |
| cam2 | 15% | **2%** |

V3 is **4–7× worse at night** than during the day. The Phase 0.2
baseline already showed cam2 has many more zone-touches than cam1
at all hours, so the 2% IR fire-rate on cam2 means **the vast
majority of Remy's nighttime activity is invisible to V3**.

Why night/IR is hard:

- **Grayscale only** — IR illumination removes all color signal
- **Single-direction IR LED illumination** flattens depth cues and
  produces hard shadows on Remy's silhouette
- **Reduced contrast** between Remy and bedding, hide interior, and
  cage furniture
- **Public training-data deficit** — the 6 public datasets V3 trained
  on are overwhelmingly daylight color images; almost no IR coverage

Wheel-on-night adds two more factors on top of the general night
problem:

- **Motion blur** from the spinning wheel + running posture
- **Wheel occlusion** — spokes/rim crossing Remy's silhouette at
  the camera's ~45° angle

**Implications for V4:**

- **Night/IR recall is the dominant V3 failure mode** — and it's not
  visible in the diary just as missing wheel time. Every "exploring"
  entry that should have been "tunnel" / "food" / "water", every
  short event where Remy entered and exited a zone faster than V3
  could lock on, every long mid-activity gap — they all trace back
  to night/IR recall.
- The current public-dataset base cannot be made to cover this case
  with more public data ([[project_model_tuning]] V2 result already
  proved adding more public hurts). The lever is **real cage IR
  frames, labeled, oversampled**.
- The existing 671-frame harvest **is biased away from the gap** —
  pulled via `has_snapshot=1`, which excludes events V3 missed
  entirely. The hardest night/IR frames (Remy in IR-flat-contrast
  positions V3 saw as background) are NOT in that corpus.

V4 must address this directly via **broad night/IR harvest** (§1.5,
not detection-driven) and a **dedicated eval gate** (§4.2.6). Like
reflection-vs-live (§1.2.5), this cannot be papered over with Frigate
filters — it's a recall problem at the model.

### 1.2.5 Known V3 failure mode — reflection beats live hamster

**Symptom (observed in review of V3 event frames, 2026-05-29):** when both
the live Remy **and his reflection** appear in the same frame (cage glass,
water bowl glint, dark hide interior), V3 routinely selects the
**reflection** as its top-scoring detection and **ignores the live
hamster**. The reflection often scores higher than (or equal to) the
real animal, so NMS keeps the wrong box. This is not a recall failure
(V3 *does* see hamster-shaped things) — it's a **ranking failure**.

This is what the V3 negative pass missed. The 200 V3 negatives taught
the model *"empty reflection ≠ hamster"*. They did NOT teach the model
*"in a frame with both, pick the live one."* Reflection-only negatives
suppress phantom fires on empty frames, but when both classes of pixel
appear together the model still finds the reflection compelling and
NMS can't disambiguate at the score level.

V4 must address this directly through **co-occurrence training data**
(§1.4) and a **dedicated eval gate** (§4.2.5). It cannot be papered over
with Frigate filters — the reflection's bounding box passes every
size/aspect/score filter the live hamster does.

### 1.3 [HUMAN] box review (the work that buys accuracy)

- [ ] Push frames + V3 pre-labels to a free Roboflow project (or local
      labelImg / Label Studio).
- [ ] Tighten loose boxes, add the misses (sleeping/curled/partial Remy is
      the high-value class), delete phantom boxes on reflections.
- [ ] **Co-occurrence frames (the V3 fix):** for any frame containing
      both the live Remy AND a reflection, box **only the live Remy**.
      Do **not** box the reflection. If V3's pre-label put the box on
      the reflection (likely — that's the bug we're fixing), **delete
      that box and re-draw on the live animal**. These frames are the
      single most important training data V4 will see.
- [ ] Tag the co-occurrence frames during review (e.g. filename prefix
      `coocc_` or a Roboflow tag). You'll need to find them again in
      §2.5 to carve out the held-out co-occurrence test set.
- [ ] Budget 30–60 min. Skipping this step makes V4 a re-skin of V3.
- [ ] Export reviewed as YOLOv8 to
      `~/pet-models/hamster/local/cage_pos/{images,labels}` —
      **overwrite** the contaminated v1 labels.

### 1.5 Targeted night/IR harvest (the V3-blind-spot fix)

The §1.1 harvest used `has_snapshot=1`, which only returns events V3
actually fired on. **Night/IR frames where V3 missed entirely are
absent — and those are exactly the training data V4 needs most.**
We're not just topping up wheel frames; we're filling in a 92–98%
recall hole that spans every activity in the IR period.

Four complementary pull strategies, run on the live host
(`omegaprime@project-server`):

1. **Zone-driven across ALL zones, not detection-driven**: pull every
   event during the IR window (22:00–06:00 PDT) regardless of whether
   V3 fired mid-event. Frigate logs zone entries/exits even when the
   detector loses the object inside the zone. This catches the
   "entered tunnel/wheel/food/water, V3 lost it, exited" pattern
   across the entire cage.

   ```sh
   # Night-IR events from cam1 + cam2 since 2026-05-26 (post-flicker-fix).
   # No has_snapshot filter — we want events V3 missed.
   AFTER=$(date -u -d '2026-05-27 04:00:00 UTC' +%s)   # 21:00 PDT 5-26
   for CAM in hamster_cam_1 hamster_cam_2; do
     curl -s "http://127.0.0.1:5000/api/events?cameras=${CAM}&after=${AFTER}&limit=5000" \
       | jq -r '.[] | select(.start_time | (. % 86400) >= 18000 or (. % 86400) < 50400) | .id'
       # The select filter approximates "PDT night" without TZ libs.
   done
   ```

2. **Motion-recording sampling during quiet zones**: Frigate keeps
   motion-driven recording segments (`record.motion.days: 10`) even
   when no object detection fired. Pull frames from those segments
   during the IR window, sampled at 5-second intervals. This is the
   **highest-value harvest** because it includes the frames V3 never
   surfaced — the worst-case training examples.

   ```sh
   # Sketch: list motion segments, extract one frame per 5s.
   docker exec hamster-frigate ffmpeg -i \
     /media/frigate/recordings/<YYYY-MM-DD>/<HH>/<cam>/<UTC>.mp4 \
     -vf "fps=1/5,scale=1280:720" -q:v 4 /out/frame-%04d.jpg
   ```

3. **Wheel-zone-specific sub-harvest**: as a stratified subset of (1),
   tag wheel-zone events for separate testing. The wheel case is V3's
   worst, so the eval should stratify by it.

4. **Operator debug-view captures** (Aaron-side): when you watch the
   debug-view and see V3 missing Remy at night, **screenshot the raw
   frame**. Drop them into
   `~/pet-models/hamster/harvest_v4/night_capture/`. Each one is a
   confirmed V3-failure case — extremely high signal at low cost.

**Targets:**

- ≥150 night/IR frames across all zones (the bulk lever)
- ≥80 of those in the wheel zone specifically (`wheelon_night_*`)
- ≥40 day-comparison frames for stratified eval (`wheelon_day_*`)
- Tag during §1.3 review for §2.6 carve-out:
  - `night_<zone>_` prefix for general night frames
  - `wheelon_night_` for wheel-zone IR frames
  - `wheelon_day_` for wheel-zone daylight (comparison)

**Box-review discipline (strict):**

- Box the live Remy even in heavy motion-blur frames — these are the
  ground truth V4 needs to learn from
- For frames where Remy is partially occluded (wheel rim, hide
  entrance, tunnel opening), box the visible portion only — don't
  include occluding furniture
- For frames where Remy is genuinely not visible (in hide interior,
  exited frame), **delete the frame** from the harvest — don't box
  something that isn't there. False positives in the training set
  poison V4 worse than missing frames do

### 1.4 Targeted co-occurrence harvest (additive)

The 523 night + new daytime positives will contain *some* co-occurrence
frames incidentally. We want **more**. From the same recording window
(`2026-05-25 19:00` onward), pull additional frames specifically chosen
because both Remy and a clear reflection are visible:

- [ ] On the dev Mac after the §1.1 harvest, eyeball the
      `~/pet-models/hamster/harvest/{day,night}/` directories — sort by
      filename / browse a few hundred — and pull out frames with
      obvious mirror-image pairs (Remy + glass reflection, Remy + water
      bowl, Remy at the front of the cage near a hide opening).
- [ ] Target: **40–80 co-occurrence frames**, balanced across day/night
      and cam1/cam2.
- [ ] Tag them (`coocc_*.jpg`) and review them as part of §1.3 — the
      label rule is the same: box the live animal, never the reflection.
- [ ] These frames join `~/pet-models/hamster/local/cage_pos/` like any
      other reviewed positive. They are NOT a separate `local_sources`
      entry — they're just well-chosen positives. The training signal
      *is* the label discipline (live boxed, reflection unboxed-as-background
      in the same frame). YOLO treats unboxed regions of a positive image
      as background, which is exactly the lesson we need.

---

## 6. Phase 2 — held-out cage test set (mandatory)

**Owner: Aaron · Time: ~15 min HUMAN.**

You can't tune what you can't measure. V3 deployed without this; V4 will not.

- [ ] From the §1 reviewed pool, set aside **80–120 frames** —
      mix cam1/cam2, day/night, easy/occluded/sleeping — under
      `~/pet-models/hamster/cage_test/{images,labels}`.
- [ ] Write `cage_test.yaml` (`split: test`, paths absolute).
- [ ] **These frames never touch train or val.** Move them out of
      `cage_pos/` before §3 build runs, so the deterministic split can't
      leak them.

### 2.6 Held-out night/IR eval set (mandatory for V4)

V3's broad night/IR recall gap is the dominant failure mode (§1.2.6).
V4 must measurably fix it on data the model never saw during training.

- [ ] From the §1.5 night/IR harvest, set aside **30–50 frames** total
      under `~/pet-models/hamster/cage_night_test/{images,labels}`,
      stratified:
      - **20–30 general night frames** across activities (tunnel,
        food, water, exploring) — the bulk of the eval signal
      - **10–15 `wheelon_night_*` frames** — the severe subcase
      - **5 `wheelon_day_*` frames** — daylight comparison so we can
        report "delta vs the same activity in good lighting"
- [ ] Write `cage_night_test.yaml` (`split: test`, paths absolute).
- [ ] **These frames never touch train, val, the cage_test set, OR
      the co-occurrence test set.** They are a dedicated night/IR
      eval set.
- [ ] Each frame's label file boxes the live Remy. No boxes on the
      wheel itself, motion-blur artifacts, or shadow regions.

### 2.5 Held-out co-occurrence eval set (mandatory for V4)

V3's headline regression is reflection-beats-live (§1.2.5). V4 must
measurably fix it on data the model never saw during training.

- [ ] From the §1.4 co-occurrence harvest, set aside **20–30 of the
      tagged `coocc_*` frames** — under
      `~/pet-models/hamster/cage_coocc_test/{images,labels}`.
- [ ] Write `cage_coocc_test.yaml` (`split: test`, paths absolute).
- [ ] **These frames never touch train, val, OR the cage_test set.** They
      are a dedicated reflection-handling eval set.
- [ ] Each frame's label file boxes **only the live hamster**. The
      reflection is intentionally left unboxed (background-in-positive)
      so the eval scorer compares "did the model put its highest-scoring
      box on the live animal or on a region that doesn't have a label?"

---

## 7. Phase 3 — train V4

**Owner: Claude (autonomous) · Time: ~30–60 min on MPS.**

### 3.1 Config delta on `scripts/pet-model/pets/hamster.yaml`

```yaml
local_sources:
  - path: ~/pet-models/hamster/local/cage_neg
    role: negative
  - path: ~/pet-models/hamster/local/cage_pos   # enable for V4 recall pass
    role: positive

local_oversample: 4    # was 2 — cage data is dwarfed by ~2700 public positives
imgsz: 480              # was 320 — Option C: bigger input tensor for small-Remy + occluded recall.
                        # Inference cost roughly 2.25× (V3 ~14ms → V4 ~31ms).
                        # Budget: 10fps × 2 cams × 31ms ≈ 620ms/sec (62% used).
                        # DO NOT pair with a detect.fps bump in the same deploy.
epochs: 200             # was 150
patience: 60            # was 50
batch: 24               # was 32 — drop to keep MPS VRAM under the 480² ceiling;
                        # if your dev Mac has headroom, leave at 32

# augment block unchanged from V3 (Phase I knobs already wired)
# base_model: yolov9t.pt  — only bump to yolov9s if Phase J fails
```

### 3.2 Train

```sh
export ROBOFLOW_API_KEY=...   # verify .env has a valid 20-char private key
./scripts/pet-model/run.sh scripts/pet-model/pets/hamster.yaml
```

### 3.3 Park artifacts

- [ ] `mkdir -p models/hamster/v4`
- [ ] Copy `best.pt`, `hamster_y9.onnx`, `hamster.txt` into it.
- [ ] Commit (`.gitignore` exception already in place).

---

## 8. Phase 4 — Gate J (the only gate that matters)

**Owner: Claude (autonomous) · Time: ~5 min.**

### 4.1 Cage-test mAP50

```sh
yolo detect val model=models/hamster/v3/best.pt data=cage_test.yaml imgsz=320 split=test
yolo detect val model=models/hamster/v4/best.pt data=cage_test.yaml imgsz=480 split=test
```

**Honest note on the V3-vs-V4 comparison**: V3 ran at imgsz=320 in
production and is evaluated at its native size. V4 runs at imgsz=480.
This is what's live vs what we'd ship. If V4 wins, you do not know how
much of the lift comes from cage data vs imgsz — Option C explicitly
accepts that confound. See §10.5.

### 4.2 Negative eval

Re-run the 200-frame negative eval (Phase H artifact) on V4 at conf 0.50,
0.55, 0.60, 0.65.

### 4.2.5 Co-occurrence eval (reflection-vs-live ranking)

The V3-fix gate. For each frame in `cage_coocc_test`, run V3 AND V4 at
conf 0.25 (intentionally permissive so both models surface their
reflection box), then compare:

```sh
yolo detect predict model=models/hamster/v3/best.pt source=cage_coocc_test/images \
  imgsz=320 conf=0.25 save_txt=True save_conf=True project=eval name=v3_coocc
yolo detect predict model=models/hamster/v4/best.pt source=cage_coocc_test/images \
  imgsz=480 conf=0.25 save_txt=True save_conf=True project=eval name=v4_coocc
```

Score each frame:

- **Correct** if the model's **highest-confidence box** has IoU ≥ 0.4
  with the labeled live-hamster box.
- **Wrong** if the highest-confidence box is anywhere else (i.e. landed
  on the reflection or a phantom region).

Pass criteria for V4:

- [ ] **V4 correct ≥ 95% of co-occurrence frames**
- [ ] **V4 correct > V3 correct** by at least 20 percentage points
      (V3's current failure rate on these frames is the whole reason
      this eval exists; a marginal lift means the training signal
      didn't take)

### 4.2.6 Night/IR eval (the V3-blind-spot fix gate)

Pure recall gate. Run V3 AND V4 against `cage_night_test` at conf
0.25 (permissive — we want to see what each model surfaces):

```sh
yolo detect val model=models/hamster/v3/best.pt data=cage_night_test.yaml imgsz=320 split=test
yolo detect val model=models/hamster/v4/best.pt data=cage_night_test.yaml imgsz=480 split=test
```

Score: standard mAP50 + recall, both overall and stratified by the
filename prefix tags.

Pass criteria for V4 (overall):

- [ ] **V4 mAP50 ≥ 0.80** on the full night set
- [ ] **V4 recall ≥ 0.85** at conf 0.50 (the operating threshold the
      live Frigate will pull from after Phase K relaxes 0.65 → 0.60).
      Recall is the metric that matters here — false positives in
      the night cage are caught by §4.2 negative eval; what matters
      is "does the model see Remy at night."
- [ ] **V4 mAP50 strictly > V3** by **≥ 30 percentage points** on the
      same set. V3 is at ~2–8% recall here; a 30pp lift is the
      minimum to claim the cage data lever took for night/IR.

Stratified pass criteria (reported but not gating):

- [ ] V4 recall on `wheelon_night_*` ≥ 0.75 — severe subcase, slightly
      looser bar than overall
- [ ] V4 recall on `wheelon_day_*` ≥ 0.95 — daylight wheel should be
      near-perfect; if it isn't, V4 has regressed somewhere

### 4.3 Decision

V4 **ships only if all six hold**:

- [ ] Cage-test mAP50 ≥ 0.85
- [ ] Cage-test mAP50 strictly > V3's score on the same set
- [ ] 0/200 FPs at the live operating point (whatever §10.1 resolved to)
- [ ] **Co-occurrence eval ≥ 95% correct AND > V3 by 20 pp** (§4.2.5)
- [ ] **Night/IR overall mAP50 ≥ 0.80 AND recall ≥ 0.85 AND > V3 by 30 pp** (§4.2.6)
- [ ] Gate C (no embedded NMS, shape `[1,3,320,320]`) passes

If any fail: **do not deploy.** Diagnose. Usually = need more cage data
(append-only re-harvest), or oversample tweak, or backbone bump to
yolov9s. If §4.2.5 specifically fails, the box review of co-occurrence
frames probably let some reflection-box labels through — re-do §1.3 on
the `coocc_*` frames before re-training. Public mAP is not a tiebreaker.

---

## 9. Phase 5 — deploy + Phase K finalization

**Owner: Claude (auto for SCP/edit/restart) + Aaron (sign-off) · Time:
~15 min + 24h watch.**

One restart, two changes, one rollback button.

### 5.1 SCP V4 ONNX

```sh
scp models/hamster/v4/hamster_y9.onnx \
  omegaprime@project-server:/opt/hamster-cam/models/hamster_y9_v4.onnx
ssh omegaprime@project-server "ls -la /opt/hamster-cam/models/"
```

**Keep `hamster_y9_v3.onnx`** (current production, currently named just
`hamster_y9.onnx`) untouched as the rollback target — rename it first:

```sh
ssh omegaprime@project-server \
  "cd /opt/hamster-cam/models && cp hamster_y9.onnx hamster_y9_v3.onnx"
```

### 5.2 Edit live Frigate config

**Five** coordinated edits (Frigate UI or scp), all reverted as one
rollback button (§5.5):

1. `model.path: /config/model_cache/hamster_y9_v4.onnx`
2. **`model.width: 320 → 480`** (Option C)
3. **`model.height: 320 → 480`** (Option C)
4. `objects.filters.hamster.threshold: 0.65 → 0.60` (or 0.55 if Phase 4
   showed V4 holds precision at conf 0.55).
5. Resolve per-cam `min_score: 0.5` ambiguity from §10.1 (either delete the
   per-cam line, or align to global).

**Note on `detect.width/height` (intentionally NOT in the list above):**
The per-camera `detect.width: 1280, detect.height: 720` block is the
*camera-capture* resolution Frigate downscales **into** `model.W/H`.
**V4 stays at 720p detect, regardless of whether Pi 4 / 1080p migration
happens later.** V4's value is the imgsz bump from 320 → 480 against the
existing 720p source — that alone delivers ~2.25× more pixels per
detection (1280×720 downscaled to 480×480 vs 320×320). Bumping detect
above 720p is a separate optimization tied to a hypothetical 1080p
source — see §10.6 — and is not in scope for V4.

### 5.3 Restart + verify

```sh
ssh omegaprime@project-server "docker compose -f /opt/hamster-cam/docker-compose.yml restart frigate"
ssh omegaprime@project-server "docker logs --tail=200 hamster-frigate | grep -iE 'model|onnx|input|shape|width|error'"
ssh omegaprime@project-server "curl -s http://127.0.0.1:5000/api/stats | jq '.detectors.ov, .cameras'"
```

Expect (Option C):

- Clean model load — no shape-mismatch errors in the log
- `inference_speed` **~28–35 ms** (V3 at 320 was ~14 ms; V4 at 480 is
  ~2.25× per-inference). If `inference_speed` is still ~14 ms, the
  model may have failed to load and Frigate fell back to a previous
  state — check the log for `tensor shape` / `input` errors.
- Both cams `detection_fps > 0` on motion
- No ONNX errors

### 5.4 [HUMAN] sign-off

- [ ] Eyeball Frigate debug view across a full day/night cycle.
- [ ] Watch the app diary — tunnel/wheel/partial Remy events should appear
      that previously fell below the 0.65 threshold.
- [ ] Compare event count and diary entries to §0.2 baseline.

### 5.5 Rollback (if needed)

Option C requires three coordinated reverts (vs Plan A's one):

```sh
ssh omegaprime@project-server \
  "cd /opt/hamster-cam/models && cp hamster_y9_v3.onnx hamster_y9.onnx"
# Revert frigate-config:
#   - model.path back to V3 ONNX (above)
#   - model.width 480 → 320
#   - model.height 480 → 320
#   - threshold 0.60 (or 0.55) → 0.65
# All four edits in one Frigate config write, then:
ssh omegaprime@project-server "docker compose -f /opt/hamster-cam/docker-compose.yml restart frigate"
```

Under 60 seconds. **Don't rollback just the .onnx without also reverting
model.width/height — V3 was trained at 320 and Frigate will refuse to
load it at width 480.**

---

## 10. Open questions / decisions log

### 10.1 Per-camera vs global `min_score`

Both `0.5` (per-cam) and `0.55` (global) exist in the live config.
Pending §0.3.

- [ ] Answer: _(fill in after 0.3)_
- [ ] Action: _(delete per-cam line | align to global | leave as-is)_

### 10.2 Backbone — yolov9t vs yolov9s

V3 used `yolov9t.pt`. V4 will start there. If Phase 4 fails Gate J on
recall, bump to `yolov9s.pt` and re-run §7. Re-verify
`detectors.ov.inference_speed` stays under the 5 fps detect budget at 320.

- [ ] Decision: _(yolov9t default; revisit only if Gate J fails)_

### 10.3 Final threshold target

- [ ] Conservative: 0.65 → 0.60 (small step, safer).
- [ ] Aggressive: 0.65 → 0.55 (full Phase K — only if V4 is clean at conf
      0.55 in negative eval).

### 10.6 detect.width/height — out of scope for V4

**V4 stays at `detect.width: 1280, detect.height: 720` no matter what.**
Whether the Pi 4 + 1080p migration ever happens does not change V4's
deploy or rollback. The plan is fully decoupled.

The two settings sit at different layers and change for different reasons:

| Setting | What it is | When to change |
|---|---|---|
| `detect.width / detect.height` | Camera-capture resolution Frigate reads from the stream | Only when source stream resolution changes. Not now. Not part of V4. |
| `model.width / model.height` | Tensor shape the detector expects | When the model is retrained at a new imgsz. **V4 = 480**. |

If you ever do the Pi 4 + 1080p migration as a **separate, later
workstream**, the `detect.W/H` bump from 1280×720 → 1920×1080 is its own
decision. It is not implied by V4, not blocked on V4, not unblocked by
V4. The two changes are orthogonal.

Why this matters operationally:

- V4's deploy diff stays at 5 lines (§5.2). It does not grow.
- V4's rollback button stays simple (model.path + width + height +
  threshold + per-cam min_score).
- If you do migrate to Pi 4 + 1080p someday, the source upgrade plus a
  detect.W/H bump is its own change with its own risk profile — chiefly
  software-decode CPU on the Mini. Treat it like any other infra
  change: measure with `scripts/cam-health.sh` before and after.

### 10.5 imgsz 320 vs 480 — RESOLVED (Option C)

**Decision (2026-05-29):** V4 trains AND evaluates AND deploys at
**imgsz=480**, bundled with the cage-data lever. Trade accepted:

- ✅ **Pro**: small-Remy / partial-occlusion / sleeping-in-tunnel recall
  improves measurably (more pixels per region in the input tensor)
- ✅ **Pro**: single deploy, single rollback button, single experiment
- ⚠️ **Con**: V4 vs V3 cage-test mAP50 win cannot be cleanly attributed
  between "cage data + co-occurrence labels" and "input resolution".
  Successful V4 lands without knowing which lever drove it. The plan
  explicitly accepts this — see §1 Mission.
- ⚠️ **Inference budget**: V3 ~14 ms → V4 ~31 ms. At 10 fps × 2 cams =
  62% used. Comfortable but smaller margin than V3. Do **not** bundle
  a `detect.fps` bump with the V4 deploy.

If V4 ships and a later regression-bisection becomes important
(e.g. for V5 design), a one-off V4-at-320 build off the same harvest
can answer the attribution question. Not needed for the V4 ship
decision.

### 10.4 `tpicos-2-maurcio/hamster-and-guinea-pig` dataset

Currently commented out of `pets/hamster.yaml`. The Phase J test set in V4
gives us the measurement to decide. Defer to a hypothetical V5.

---

## 11. Hard no-gos (don't break these)

- **Do not** train on the 523 night frames with their existing v1 labels —
  re-label with V3 first.
- **Do not** skip Phase 2 (held-out test set). "Better recognition" without
  numbers is not a deliverable.
- **Do not** bundle Phase K relax with V4 as a single change in §5.2 unless
  you have ONE rollback button (current plan does — model + threshold flip
  together, rollback restores both).
- **Do not** delete `hamster_y9_v3.onnx` from the host. V3 is the insurance
  policy.
- **Do not** suggest adding zones to cam2 that it can't physically see (bed,
  hide, food, water, tunnel). See [`project_camera_fov`](../) memory.
- **Do not** ship V4 if the night/IR eval (§4.2.6) doesn't show a
  measurable recall lift over V3. V3 is at 2–8% IR fire-rate; the
  diary's "Remy disappears at night" pattern is the dominant
  user-visible V3 failure. A V4 that doesn't fix the night recall
  ships the same daily complaint.
- **Do not** ship V4 if the co-occurrence eval (§4.2.5) doesn't fix the
  reflection-wins-over-live failure mode. A V4 that matches V3 on cage
  mAP50 but still picks the reflection in mirror-image frames is a lateral
  move, not a recall pass — the same diary noise will keep showing up.
- **Do not** box the reflection in co-occurrence frames during §1.3 review.
  The label discipline IS the training signal — boxing both teaches the
  model both are hamsters, which is the V3 bug.
- **Do not** bundle a `detect.fps: 10 → 15` bump with the V4 deploy
  (Option C). V4 at imgsz=480 lands at ~62% of detector budget at 10 fps;
  going 15 fps puts it at ~93% — one motion burst and you queue. Ship
  V4 first, bake for a week with inference_speed under watch, THEN
  consider the fps bump as a separate change.
- **Do not** rollback V4's ONNX without ALSO reverting
  `model.width/height` from 480 → 320 (§5.5). V3 was trained at 320;
  Frigate will refuse to load it at width 480 and the stack will be
  down until you re-edit and restart.

---

## 12. Human gates (everything else is autonomous)

1. **[HUMAN]** §0.1 mask audit visual review.
2. **[HUMAN]** §0.3 per-cam `min_score` empirical check (or delegate to
   Claude with a clear "look at events with top_score in [0.50, 0.55)" ask).
3. **[HUMAN]** Confirm `ROBOFLOW_API_KEY` in `.env` is still the 20-char
   private key.
4. **[HUMAN]** §1.3 box review of harvested cage frames — **the work that
   actually buys accuracy**. Pay special attention to co-occurrence frames
   (§1.4): box ONLY the live hamster, never the reflection.
5. **[HUMAN]** §5.4 live debug-view sign-off across a day/night cycle.

---

## 13. Definition of done

A versioned `hamster_y9_v4.onnx` deployed at
`/opt/hamster-cam/models/hamster_y9_v4.onnx`, with Frigate `threshold`
relaxed from 0.65, that:

- Beats V3 on a cage-held-out test set (mAP50 ≥ 0.85 AND > V3),
- Holds 0/200 FPs on the negative eval at the new live threshold,
- Survives 24h of live operation without an uptick in phantom diary
  entries vs the §0.2 baseline,
- Has a one-line rollback to V3.
