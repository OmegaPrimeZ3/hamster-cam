# Hamster detector — model releases

Versioned, deployable detector releases for the Frigate stack. Each `vN/` holds:

| File | What it is |
|---|---|
| `hamster_y9.onnx` | The **deployable** model — Frigate `yolo-generic`, 320×320, NCHW float, **no embedded NMS**, opset 12. This is what ships to the host model cache. |
| `best.pt` | YOLOv9-tiny training weights (optimizer state stripped) — for resuming / future fine-tunes. |
| `hamster.txt` | Single-line labelmap (`hamster`). |

The training pipeline that produces these lives in [`../../scripts/pet-model/`](../../scripts/pet-model/);
the tuning runbook is [`docs/HAMSTER_MODEL_TUNING.md`](../../docs/HAMSTER_MODEL_TUNING.md).
Pipeline artifacts (datasets, runs) stay **outside** the repo by design — only these
curated releases are committed (see the `models/` exception in `.gitignore`).

## Versions

| Ver | Date | Training data | Val mAP50 | Notes |
|---|---|---|---|---|
| **v1** | 2026-05-22 | 3 public Roboflow sets (~435 imgs) | ≥0.85 (gate) | Original public-only baseline. Generalises, but mistakes cage furniture for a hamster. |
| **v2** | 2026-05-26 | Phase F: 6 public sets (~2700 imgs) | ≥0.85 (gate) | Broadened public base (added the pet-monitor/cage-cam set). |
| **v3** | 2026-05-26 | v2 sets **+ 200 real-cage background negatives** (bedding fluff, wooden house, reflections) + day/night augmentation | **0.9722** | **Current best.** Trained to *not* fire on the static cage objects that were false-positiving in production (~71–77% in Frigate events). |

### v3 precision eval (false positives on 200 held-out cage negatives)

| Model | conf ≥ 0.50 | conf ≥ 0.70 |
|---|---|---|
| v2 (public only) | 4 / 200 (2.0%) | 0 / 200 |
| **v3 (+negatives)** | **0 / 200 (0.0%)** | **0 / 200** |

> Caveat: this eval runs `best.pt` locally on MPS. Production runs `hamster_y9.onnx`
> on OpenVINO, which can score differently — the real acceptance test is live
> observation across a day/night cycle (runbook Phase J / Gate K). v3 is the
> strongest candidate on every measurable axis; deploy and verify on the cage.

## Deploying a version

Versioned + rollback-safe (runbook §10):

```sh
# Ship the chosen version's ONNX + labelmap to the host model cache (keep the old one).
scp models/hamster/v3/hamster_y9.onnx omegaprime@project-server:/opt/hamster-cam/storage/model_cache/hamster_y9_v3.onnx
scp models/hamster/v3/hamster.txt     omegaprime@project-server:/opt/hamster-cam/storage/model_cache/hamster.txt
# Point Frigate's model.path at hamster_y9_v3.onnx (via the Frigate UI config editor
# to avoid clobbering drawn zones), then restart Frigate.
```

Rollback = point `model.path` back at the previous file and restart. The previous
ONNX stays on the host.
