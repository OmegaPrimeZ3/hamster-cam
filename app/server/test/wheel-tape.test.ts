// app/server/test/wheel-tape.test.ts
// Unit and integration tests for the tape-crossing detector.
//
// Test surface:
//   BrightnessSignal    — Welford rolling stats, dip detection, refractory period,
//                         whole-frame brightness normalisation, warmup gate
//   TapeSessionMachine  — session lifecycle FSM
//   meanBrightness      — utility
//   roiMeanBrightness   — utility
//   Narrator integration — synthetic dip sequence → diary entry with correct wheel_meters
//
// No real ffmpeg processes are spawned; the public ffmpeg-spawn paths are
// covered by integration smoke through the always-on detector helpers.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BrightnessSignal,
  TapeSessionMachine,
  meanBrightness,
  roiBandReferenceMean,
  roiMeanBrightness,
  type RoiPct,
} from '../src/wheel-tape.js';

// ---------------------------------------------------------------------------
// meanBrightness — utility
// ---------------------------------------------------------------------------

describe('meanBrightness', () => {
  it('returns 128 for an empty buffer', () => {
    expect(meanBrightness(Buffer.alloc(0))).toBe(128);
  });

  it('returns exact value for a uniform buffer', () => {
    expect(meanBrightness(Buffer.alloc(100, 200))).toBe(200);
  });

  it('averages correctly for mixed values', () => {
    const buf = Buffer.from([0, 100, 200]);
    expect(meanBrightness(buf)).toBeCloseTo(100, 5);
  });

  it('returns 0 for an all-zero buffer', () => {
    expect(meanBrightness(Buffer.alloc(10, 0))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// roiMeanBrightness — utility
// ---------------------------------------------------------------------------

describe('roiMeanBrightness', () => {
  // 10×4 frame (40 pixels). ROI covers left half: x=0,y=0,w=50,h=100 → x:0-4,y:0-3 (20 px).
  const FW = 10;
  const FH = 4;
  const halfRoi: RoiPct = { x: 0, y: 0, w: 50, h: 100 };

  it('returns correct mean for a uniform ROI', () => {
    const buf = Buffer.alloc(FW * FH, 100);
    // All pixels same → roi mean = frame mean = 100.
    expect(roiMeanBrightness(buf, FW, FH, halfRoi)).toBe(100);
  });

  it('isolates ROI pixels from non-ROI pixels', () => {
    // Left half = 200, right half = 50.
    const buf = Buffer.alloc(FW * FH, 50);
    for (let y = 0; y < FH; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        buf[y * FW + x] = 200;
      }
    }
    // ROI covers left half (x 0–4): should be 200.
    expect(roiMeanBrightness(buf, FW, FH, halfRoi)).toBe(200);
    // Overall mean is (5×200 + 5×50)/10 = 125 per row → 125.
    expect(meanBrightness(buf)).toBe(125);
  });

  it('falls back to whole-frame mean for a degenerate zero-area ROI', () => {
    const buf = Buffer.alloc(FW * FH, 77);
    // Zero-width ROI → fallback.
    const zeroRoi: RoiPct = { x: 0, y: 0, w: 0, h: 50 };
    expect(roiMeanBrightness(buf, FW, FH, zeroRoi)).toBe(77);
  });

  it('clamps ROI that extends beyond frame boundary', () => {
    const buf = Buffer.alloc(FW * FH, 100);
    // ROI starting at 90% with 50% width → clamps to frame right edge.
    const clampRoi: RoiPct = { x: 90, y: 0, w: 50, h: 100 };
    // Should not throw; result is valid brightness in 0–255.
    const result = roiMeanBrightness(buf, FW, FH, clampRoi);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(255);
  });
});

// ---------------------------------------------------------------------------
// roiBandReferenceMean — utility
// ---------------------------------------------------------------------------

describe('roiBandReferenceMean', () => {
  // 20×10 frame. ROI centred: x=40%,y=40%,w=20%,h=20% → x:8-12, y:4-6.
  // Left background: columns 0-7 (8 px = 40% of width).
  // Right background: columns 12-19 (8 px = 40% of width).
  const FW = 20;
  const FH = 10;
  const centreRoi: RoiPct = { x: 40, y: 40, w: 20, h: 20 };

  it('returns the mean of pixels in the same Y rows but outside ROI X range', () => {
    // Frame: ROI rows (y 4-5) have background=100, ROI pixels=200.
    // Outside ROI rows irrelevant — band ref only samples ROI Y range.
    const buf = Buffer.alloc(FW * FH, 100);
    // Paint ROI pixels a different value; band ref should exclude them.
    const roiX0 = Math.round(FW * 40 / 100); // 8
    const roiX1 = Math.round(FW * 60 / 100); // 12
    const roiY0 = Math.round(FH * 40 / 100); // 4
    const roiY1 = Math.round(FH * 60 / 100); // 6
    for (let y = roiY0; y < roiY1; y += 1) {
      for (let x = roiX0; x < roiX1; x += 1) {
        buf[y * FW + x] = 200;
      }
    }
    const ref = roiBandReferenceMean(buf, FW, FH, centreRoi);
    // Background in ROI Y rows is 100 (left cols 0-7 and right cols 12-19).
    expect(ref).not.toBeNull();
    expect(ref!).toBeCloseTo(100, 5);
  });

  it('returns null when ROI spans the full frame width (no X background available)', () => {
    const buf = Buffer.alloc(FW * FH, 128);
    // ROI covers x=0..100% (full width).
    const fullWidthRoi: RoiPct = { x: 0, y: 0, w: 100, h: 100 };
    expect(roiBandReferenceMean(buf, FW, FH, fullWidthRoi)).toBeNull();
  });

  it('returns null when both sides have fewer than 5% of frame width in columns', () => {
    // Frame 100 wide. ROI covers x=3%..97% leaving only 3 cols on each side (3%).
    const BW = 100;
    const BH = 20;
    const narrowBuf = Buffer.alloc(BW * BH, 128);
    const nearFullRoi: RoiPct = { x: 3, y: 0, w: 94, h: 100 };
    // Left side: 3 cols = 3% < 5% threshold. Right side: 3 cols = 3% < 5%.
    expect(roiBandReferenceMean(narrowBuf, BW, BH, nearFullRoi)).toBeNull();
  });

  it('uses only the available side when one side is wide enough and the other is not', () => {
    // Frame 100 wide. ROI x=2%,w=60% → left=2 cols (2%), right=38 cols (38%).
    // Only right side qualifies. Band ref should equal mean of right-side pixels in ROI Y.
    const BW = 100;
    const BH = 20;
    const leftEdgeRoi: RoiPct = { x: 2, y: 40, w: 60, h: 20 };
    // roiX0 = round(100*2/100)=2, roiX1=round(100*62/100)=62.
    // Left: 2 cols → 2% < 5% → not used. Right: 38 cols → 38% → used.
    const buf = Buffer.alloc(BW * BH, 50);
    // Paint right-side pixels in ROI Y rows to a known value.
    const roiX1 = Math.round(BW * 62 / 100); // 62
    const roiY0 = Math.round(BH * 40 / 100); // 8
    const roiY1 = Math.round(BH * 60 / 100); // 12
    for (let y = roiY0; y < roiY1; y += 1) {
      for (let x = roiX1; x < BW; x += 1) {
        buf[y * BW + x] = 150;
      }
    }
    const ref = roiBandReferenceMean(buf, BW, BH, leftEdgeRoi);
    expect(ref).not.toBeNull();
    expect(ref!).toBeCloseTo(150, 5);
  });
});

// ---------------------------------------------------------------------------
// BrightnessSignal — frame layout and test helpers
// ---------------------------------------------------------------------------

/**
 * Test frame configuration:
 *   Frame: 20 wide × 10 tall = 200 pixels
 *   ROI: x=40%,y=40%,w=20%,h=20% → x:8-11, y:4-5 → 4×2 = 8 pixels
 *
 * This small ROI allows independent control of ROI vs. background brightness
 * to test normalisation behaviour.
 */
const FRAME_W = 20;
const FRAME_H = 10;
const TEST_ROI: RoiPct = { x: 40, y: 40, w: 20, h: 20 };

/**
 * Build a test frame where all background pixels have `bgBrightness` and
 * the ROI pixels (x:8-11, y:4-5) have `roiBrightness`.
 */
function makeFrame(bgBrightness: number, roiBrightness: number): Buffer {
  const buf = Buffer.alloc(FRAME_W * FRAME_H, bgBrightness);
  // ROI: x in [8,12), y in [4,6) — matches 40/40/20/20 pct on 20×10
  const x0 = Math.round(FRAME_W * 40 / 100);  // 8
  const y0 = Math.round(FRAME_H * 40 / 100);  // 4
  const x1 = Math.round(FRAME_W * 60 / 100);  // 12
  const y1 = Math.round(FRAME_H * 60 / 100);  // 6
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      buf[y * FRAME_W + x] = roiBrightness;
    }
  }
  return buf;
}

/** Synthetic time base: 35ms per frame ≈ 28.5 fps (close enough to 30 fps). */
const FRAME_MS = 35;

/**
 * Feed N frames to a BrightnessSignal where ROI and background are the same
 * brightness (simulates a stable, untriggered wheel). Returns the final time.
 */
function feedConstant(
  signal: BrightnessSignal,
  brightness: number,
  count: number,
  startMs: number,
): number {
  let t = startMs;
  for (let i = 0; i < count; i += 1) {
    signal.feed(makeFrame(brightness, brightness), FRAME_W, FRAME_H, t);
    t += FRAME_MS;
  }
  return t;
}

/**
 * Feed N frames where only the ROI brightness alternates between two values.
 * Background stays constant. Returns the final time.
 */
function feedRoiAlternating(
  signal: BrightnessSignal,
  bg: number,
  roiA: number,
  roiB: number,
  count: number,
  startMs: number,
): number {
  let t = startMs;
  for (let i = 0; i < count; i += 1) {
    const roi = i % 2 === 0 ? roiA : roiB;
    signal.feed(makeFrame(bg, roi), FRAME_W, FRAME_H, t);
    t += FRAME_MS;
  }
  return t;
}

// ---------------------------------------------------------------------------
// BrightnessSignal — Welford rolling stats
// ---------------------------------------------------------------------------

describe('BrightnessSignal — Welford rolling stats', () => {
  it('rolling mean converges to constant signal value', () => {
    const s = new BrightnessSignal(2.0, TEST_ROI);
    // Feed 200 uniform frames (bg = roi = 100). Normalised signal = 100.
    const t = feedConstant(s, 100, 200, 1_000_000);
    expect(s.getMean()).toBeCloseTo(100, 1);
    void t;
  });

  it('rolling std is near zero for a constant signal', () => {
    const s = new BrightnessSignal(2.0, TEST_ROI);
    feedConstant(s, 150, 200, 2_000_000);
    // Normalised signal is constant 150 → std ≈ 0.
    expect(s.getStd()).toBeLessThan(1);
  });

  it('rolling std is non-zero for a noisy ROI signal', () => {
    const s = new BrightnessSignal(2.0, TEST_ROI);
    // Background stays at 150. ROI alternates 100/200. Normalised signal ≈ 100/200.
    feedRoiAlternating(s, 150, 100, 200, 200, 3_000_000);
    // Std of an alternating 100/200 signal ≈ 50.
    expect(s.getStd()).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// BrightnessSignal — dip detection (post-warmup behaviour)
// ---------------------------------------------------------------------------

/**
 * Warmup constant: 60 frames must be consumed before dip detection arms.
 * Feed WARMUP_COUNT frames to pass the gate, then test detection.
 */
const WARMUP_COUNT = 60;

describe('BrightnessSignal — dip detection', () => {
  it('counts one dip on a clear ROI brightness drop below the adaptive threshold', () => {
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 10_000_000;

    // Warm up: 200 frames, bg=200, roi=200. Signal = 200, std ≈ 0.
    t = feedConstant(s, 200, 200, t);

    // Dip: ROI drops to 50 while background stays at 200.
    // frame_mean ≈ (192×200 + 8×50)/200 = 196. frame_baseline ≈ 200.
    // normalized = 50 - (196 - 200) = 54 → huge drop from 200.
    const dipFrame = makeFrame(200, 50);
    const dipResult = s.feed(dipFrame, FRAME_W, FRAME_H, t);

    expect(dipResult).toBe(true);
    expect(s.getRecentDips(t, 5_000)).toHaveLength(1);
  });

  it('single-frame brightness spike above background does NOT trigger a dip', () => {
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 11_000_000;

    // Warm up with darkness (roi=bg=50).
    t = feedConstant(s, 50, 200, t);

    // ROI spike to 250 — should NOT be a dip (dip = below mean).
    const spikeFrame = makeFrame(50, 250);
    const spikeResult = s.feed(spikeFrame, FRAME_W, FRAME_H, t);

    expect(spikeResult).toBe(false);
    expect(s.getRecentDips(t, 5_000)).toHaveLength(0);
  });

  it('refractory period prevents double-counting within 150ms', () => {
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 12_000_000;

    t = feedConstant(s, 200, 200, t);

    const dipFrame = makeFrame(200, 50);
    const dip1 = s.feed(dipFrame, FRAME_W, FRAME_H, t);
    expect(dip1).toBe(true);
    t += FRAME_MS; // 35ms — within 150ms refractory

    const dip2 = s.feed(dipFrame, FRAME_W, FRAME_H, t);
    expect(dip2).toBe(false);

    t += FRAME_MS; // 70ms total — still within refractory
    const dip3 = s.feed(dipFrame, FRAME_W, FRAME_H, t);
    expect(dip3).toBe(false);

    expect(s.getRecentDips(t, 1_000)).toHaveLength(1);
  });

  it('dip is allowed after the refractory window clears (>=150ms between dips)', () => {
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 13_000_000;

    t = feedConstant(s, 200, 200, t);

    const dipFrame = makeFrame(200, 50);
    s.feed(dipFrame, FRAME_W, FRAME_H, t);
    t += 160; // > 150ms refractory

    // Recovery frame.
    s.feed(makeFrame(200, 200), FRAME_W, FRAME_H, t);
    t += FRAME_MS;

    const dip2 = s.feed(dipFrame, FRAME_W, FRAME_H, t);
    expect(dip2).toBe(true);
    expect(s.getRecentDips(t, 1_000)).toHaveLength(2);
  });

  it('slow ROI brightness drift does not trigger spurious dips (adaptive mean tracks drift)', () => {
    // Background stays at 150. ROI starts at 200, drifts slowly to 160 over 150 frames.
    // With noise std ≈ 8 and sensitivity = 2.0, threshold ≈ mean - 16.
    // The drift keeps the signal within ~8 units of the rolling mean — no dip fires.
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 14_000_000;

    // Warm-up: ROI alternating 192/208 around 200 (std ≈ 8).
    for (let i = 0; i < 200; i += 1) {
      const roi = i % 2 === 0 ? 192 : 208;
      s.feed(makeFrame(150, roi), FRAME_W, FRAME_H, t);
      t += FRAME_MS;
    }

    const dipsBefore = s.getRecentDips(t, 60_000).length;

    // Slow ROI drift: 200 → 160 over 150 frames (0.27 units/frame).
    for (let i = 0; i < 150; i += 1) {
      const roi = Math.round(200 - i * 0.27);
      s.feed(makeFrame(150, roi), FRAME_W, FRAME_H, t);
      t += FRAME_MS;
    }

    const dipsAfter = s.getRecentDips(t, 60_000).length;
    expect(dipsAfter - dipsBefore).toBe(0);
  });

  it('higher sensitivity triggers dips at smaller deviations', () => {
    const sLow = new BrightnessSignal(1.0, TEST_ROI);
    const sHigh = new BrightnessSignal(3.5, TEST_ROI);
    let t = 15_000_000;

    // Warm up both: bg=150, roi=200 constant → mean=200, std≈0.
    for (let i = 0; i < 200; i += 1) {
      sLow.feed(makeFrame(150, 200), FRAME_W, FRAME_H, t);
      sHigh.feed(makeFrame(150, 200), FRAME_W, FRAME_H, t);
      t += FRAME_MS;
    }

    // Build std with alternating 180/220 ROI (std ≈ 20).
    for (let i = 0; i < 100; i += 1) {
      const roi = i % 2 === 0 ? 180 : 220;
      sLow.feed(makeFrame(150, roi), FRAME_W, FRAME_H, t);
      sHigh.feed(makeFrame(150, roi), FRAME_W, FRAME_H, t);
      t += FRAME_MS;
    }
    // std ≈ 20. threshold_low = mean - 1.0*20 ≈ 180. threshold_high = mean - 3.5*20 ≈ 130.
    // ROI brightness 160: below threshold_low (160 < 180) but above threshold_high (160 > 130).

    t += 200; // clear refractory

    const dipLow = sLow.feed(makeFrame(150, 160), FRAME_W, FRAME_H, t);
    const dipHigh = sHigh.feed(makeFrame(150, 160), FRAME_W, FRAME_H, t);

    expect(dipLow).toBe(true);   // sensitivity=1.0 triggers
    expect(dipHigh).toBe(false); // sensitivity=3.5 does NOT trigger
  });

  it('counts multiple dips with refractory clearance between each', () => {
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 16_000_000;

    t = feedConstant(s, 200, 200, t);

    const TARGET = 5;
    for (let i = 0; i < TARGET; i += 1) {
      s.feed(makeFrame(200, 50), FRAME_W, FRAME_H, t);  // dip
      t += 200;
      s.feed(makeFrame(200, 200), FRAME_W, FRAME_H, t); // recovery
      t += FRAME_MS;
    }

    expect(s.getRecentDips(t, 5_000)).toHaveLength(TARGET);
  });

  it('getLiveSnapshot returns non-null samples and correct structure', () => {
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 17_000_000;

    t = feedConstant(s, 150, 50, t);

    const snap = s.getLiveSnapshot(t);
    expect(snap.samples.length).toBeGreaterThan(0);
    expect(snap.sampleMs).toBe(33); // Math.round(1000/30)
    expect(typeof snap.mean).toBe('number');
    expect(typeof snap.std).toBe('number');
    expect(typeof snap.threshold).toBe('number');
    expect(Array.isArray(snap.recentDips)).toBe(true);
    expect(typeof snap.rotationsLast30s).toBe('number');
    expect(typeof snap.rotationRateRps).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// BrightnessSignal — whole-frame normalisation (new behaviour)
// ---------------------------------------------------------------------------

describe('BrightnessSignal — whole-frame normalisation', () => {
  it('global brightness drop (autoexposure) does NOT fire a dip on the normalised signal', () => {
    // Simulate camera autoexposure dropping whole frame by 20 units.
    // Both ROI and background drop equally → frame_mean drops → normalised stays flat.
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 20_000_000;

    // Warm up at bg=200, roi=200 (200 frames well past the warmup gate).
    t = feedConstant(s, 200, 200, t);

    const dipsBefore = s.getRecentDips(t, 60_000).length;

    // 10 frames of uniform global drop: all pixels 180 (drop of 20).
    for (let i = 0; i < 10; i += 1) {
      // Uniform frame: bg = roi = 180.
      s.feed(makeFrame(180, 180), FRAME_W, FRAME_H, t);
      t += FRAME_MS;
    }

    const dipsAfter = s.getRecentDips(t, 60_000).length;
    expect(dipsAfter - dipsBefore).toBe(0);
  });

  it('local ROI drop (tape crossing) DOES fire a dip on the normalised signal', () => {
    // Only the ROI pixels darken; background is unchanged.
    // frame_mean barely moves; normalised drops sharply.
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 21_000_000;

    // Warm up: bg=200, roi=200.
    t = feedConstant(s, 200, 200, t);

    const dipsBefore = s.getRecentDips(t, 60_000).length;

    // Single tape-crossing frame: bg stays 200, ROI drops to 50.
    s.feed(makeFrame(200, 50), FRAME_W, FRAME_H, t);

    const dipsAfter = s.getRecentDips(t, 60_000).length;
    expect(dipsAfter - dipsBefore).toBe(1);
  });

  it('warmup gate: first 60 frames produce no dips even if normalised signal crosses threshold', () => {
    // Immediately after construction, the rolling window is empty.
    // Even if we see a huge dip-like signal right away, no dip should fire
    // until 60 frames have been consumed.
    const s = new BrightnessSignal(2.0, TEST_ROI);
    let t = 22_000_000;

    // Feed 59 frames that look like dips (ROI very dark vs bright background).
    // None should register — we're still in warmup.
    for (let i = 0; i < 59; i += 1) {
      s.feed(makeFrame(200, 10), FRAME_W, FRAME_H, t);
      t += FRAME_MS;
    }
    expect(s.getRecentDips(t, 60_000)).toHaveLength(0);

    // Frame 60 is still in warmup (gate is < 60).
    // Frame 61 arms the detector. But now the rolling stats have converged to
    // the dark signal, so the threshold is calibrated around it — the very-dark
    // frames should not trigger a dip against their own established mean.
    // Feed a clear dip AFTER warmup to verify detection is now armed.
    // First, stabilise signal: 200 frames of normal bg=200,roi=200.
    t = feedConstant(s, 200, 200, t);

    // Now a tape-crossing dip should fire.
    const dipResult = s.feed(makeFrame(200, 50), FRAME_W, FRAME_H, t);
    expect(dipResult).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BrightnessSignal — row-band-local normalisation (mains-flicker banding)
// ---------------------------------------------------------------------------

/**
 * Test frame builder for banding tests.
 *
 * Frame: 40 wide × 20 tall = 800 pixels.
 * ROI: x=25%,y=40%,w=50%,h=20% → x:10-30, y:8-12 (20×4 = 80 pixels).
 * Left background in ROI Y rows: columns 0-9 (25% of width — well above 5% threshold).
 * Right background in ROI Y rows: columns 30-39 (25% of width).
 *
 * To simulate mains-flicker banding: the ROI Y rows alternate between a bright
 * band value and a dark band value, while the ROI X pixels follow the SAME band.
 * A tape crossing will darken only the ROI X range while leaving the background
 * columns at the current band value.
 */
const BAND_W = 40;
const BAND_H = 20;
const BAND_ROI: RoiPct = { x: 25, y: 40, w: 50, h: 20 };

// roiX0=10, roiX1=30, roiY0=8, roiY1=12
const BAND_ROI_X0 = Math.round(BAND_W * 25 / 100); // 10
const BAND_ROI_X1 = Math.round(BAND_W * 75 / 100); // 30
const BAND_ROI_Y0 = Math.round(BAND_H * 40 / 100); // 8
const BAND_ROI_Y1 = Math.round(BAND_H * 60 / 100); // 12

/**
 * Build a frame where:
 *   - All pixels outside the ROI Y rows have value `baseVal`.
 *   - All pixels INSIDE the ROI Y rows (columns 0-39) have value `bandVal`.
 *   - ROI X pixels inside the ROI Y rows are overridden with `roiVal`
 *     (set roiVal === bandVal to simulate pure banding with no tape).
 */
function makeBandFrame(baseVal: number, bandVal: number, roiVal: number): Buffer {
  const buf = Buffer.alloc(BAND_W * BAND_H, baseVal);
  // Paint the entire ROI Y strip with the band value.
  for (let y = BAND_ROI_Y0; y < BAND_ROI_Y1; y += 1) {
    for (let x = 0; x < BAND_W; x += 1) {
      buf[y * BAND_W + x] = bandVal;
    }
  }
  // Override ROI X range with roiVal.
  for (let y = BAND_ROI_Y0; y < BAND_ROI_Y1; y += 1) {
    for (let x = BAND_ROI_X0; x < BAND_ROI_X1; x += 1) {
      buf[y * BAND_W + x] = roiVal;
    }
  }
  return buf;
}

describe('BrightnessSignal — row-band-local normalisation', () => {
  it('horizontal banding (same Y rows) does NOT fire any dips on the band-local normalised signal', () => {
    // Simulate mains-flicker: every frame the entire ROI Y strip alternates between
    // a bright band (180) and a dark band (120). The ROI pixels follow the band
    // exactly (roiVal === bandVal) — no tape, no local change.
    //
    // frame_mean oscillates between (~180 in band rows, ~150 elsewhere) and vice versa.
    // band_ref_mean oscillates between 180 and 120 in lockstep with roi_mean.
    // normalized = roi_mean - (band_ref_mean - band_baseline) ≈ 0 variation → no dip.
    const s = new BrightnessSignal(2.0, BAND_ROI);
    let t = 30_000_000;

    // Warm up: 200 frames of pure banding, alternating 120/180 across the band row.
    for (let i = 0; i < 200; i += 1) {
      const bandVal = i % 2 === 0 ? 180 : 120;
      s.feed(makeBandFrame(150, bandVal, bandVal), BAND_W, BAND_H, t);
      t += FRAME_MS;
    }

    const dipsBefore = s.getRecentDips(t, 60_000).length;

    // Run 100 more frames of banding — detector is armed. No dip should fire.
    for (let i = 0; i < 100; i += 1) {
      const bandVal = i % 2 === 0 ? 180 : 120;
      s.feed(makeBandFrame(150, bandVal, bandVal), BAND_W, BAND_H, t);
      t += FRAME_MS;
    }

    expect(s.getRecentDips(t, 60_000).length - dipsBefore).toBe(0);
  });

  it('tape crossing on a banded background DOES fire exactly one dip', () => {
    // Same banding setup. At one specific frame the ROI X pixels alone darken
    // to 30 (tape over the sensor) while the band reference columns stay at the
    // current band value. The band-local normalised signal dips sharply → one dip.
    const s = new BrightnessSignal(2.0, BAND_ROI);
    let t = 31_000_000;

    // Warm up with pure banding so the baseline is well established.
    for (let i = 0; i < 200; i += 1) {
      const bandVal = i % 2 === 0 ? 180 : 120;
      s.feed(makeBandFrame(150, bandVal, bandVal), BAND_W, BAND_H, t);
      t += FRAME_MS;
    }

    const dipsBefore = s.getRecentDips(t, 60_000).length;

    // Tape crossing: band is currently at 180 but ROI pixels drop to 30.
    // band_ref_mean stays near 180; roi_mean drops sharply.
    const tapeCrossFrame = makeBandFrame(150, 180, 30);
    s.feed(tapeCrossFrame, BAND_W, BAND_H, t);

    expect(s.getRecentDips(t + FRAME_MS, 60_000).length - dipsBefore).toBe(1);
  });

  it('ROI spans full frame width → falls back to frame_mean, uniform brightness drop does not dip', () => {
    // ROI = x:0,y:40,w:100,h:20 — spans full width.
    // roiBandReferenceMean returns null → feed() uses frame_mean as reference.
    // A uniform whole-frame brightness drop should cancel via frame_mean normalisation.
    const fullWidthRoi: RoiPct = { x: 0, y: 40, w: 100, h: 20 };
    const s = new BrightnessSignal(2.0, fullWidthRoi);
    let t = 32_000_000;

    // Warm up: uniform frames at brightness 150.
    for (let i = 0; i < 200; i += 1) {
      s.feed(Buffer.alloc(BAND_W * BAND_H, 150), BAND_W, BAND_H, t);
      t += FRAME_MS;
    }

    const dipsBefore = s.getRecentDips(t, 60_000).length;

    // Uniform drop to 130 across the whole frame.
    for (let i = 0; i < 10; i += 1) {
      s.feed(Buffer.alloc(BAND_W * BAND_H, 130), BAND_W, BAND_H, t);
      t += FRAME_MS;
    }

    expect(s.getRecentDips(t, 60_000).length - dipsBefore).toBe(0);
  });

  it('ROI covering 96% of frame width triggers fallback to frame_mean (band ref too small)', () => {
    // Use 100-wide frame. ROI x=2%,w=94% → left side 2 cols, right side 4 cols.
    // Both < 5% of frame width (5 cols threshold) → roiBandReferenceMean returns null.
    // Falls back to frame_mean. Uniform whole-frame drop → no dip.
    const VW = 100;
    const VH = 20;
    const nearFullRoi: RoiPct = { x: 2, y: 40, w: 94, h: 20 };
    const s = new BrightnessSignal(2.0, nearFullRoi);
    let t = 33_000_000;

    // Warm up: uniform frames at brightness 150.
    for (let i = 0; i < 200; i += 1) {
      s.feed(Buffer.alloc(VW * VH, 150), VW, VH, t);
      t += FRAME_MS;
    }

    const dipsBefore = s.getRecentDips(t, 60_000).length;

    // Uniform drop to 130 across the whole frame → frame_mean fallback cancels it.
    for (let i = 0; i < 10; i += 1) {
      s.feed(Buffer.alloc(VW * VH, 130), VW, VH, t);
      t += FRAME_MS;
    }

    expect(s.getRecentDips(t, 60_000).length - dipsBefore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TapeSessionMachine — session lifecycle FSM
// ---------------------------------------------------------------------------

describe('TapeSessionMachine — session lifecycle', () => {
  it('first dip starts a session (idle -> active)', () => {
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    expect(machine.getState()).toBe('idle');
    machine.onDip(1_000_000);
    expect(machine.getState()).toBe('active');
    expect(sessions).toHaveLength(0); // session not ended yet
  });

  it('session ends after 15s of no dips (idle timeout)', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 1_000_000;
    machine.onDip(t0);
    expect(machine.getState()).toBe('active');

    await vi.advanceTimersByTimeAsync(15_000);

    expect(machine.getState()).toBe('idle');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.rotations).toBe(1);
    expect(sessions[0]?.startedAt).toBe(t0);
    vi.useRealTimers();
  });

  it('session accumulates multiple dips before ending', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(2, (s) => sessions.push(s));

    const t0 = 2_000_000;
    machine.onDip(t0);
    machine.onDip(t0 + 500);
    machine.onDip(t0 + 1_000);
    machine.onDip(t0 + 1_500);
    machine.onDip(t0 + 2_000);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.rotations).toBe(5);
    vi.useRealTimers();
  });

  it('each new dip resets the idle timer so session extends', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 3_000_000;
    machine.onDip(t0);

    await vi.advanceTimersByTimeAsync(14_000);
    machine.onDip(t0 + 14_000);
    expect(machine.getState()).toBe('active');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(machine.getState()).toBe('idle');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.rotations).toBe(2);
    vi.useRealTimers();
  });

  it('forceEnd emits a session immediately', () => {
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 4_000_000;
    machine.onDip(t0);
    machine.onDip(t0 + 300);
    machine.onDip(t0 + 600);

    machine.forceEnd(t0 + 600);
    expect(machine.getState()).toBe('idle');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.rotations).toBe(3);
  });

  it('forceEnd on idle session is a no-op (no spurious empty session emitted)', () => {
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));
    machine.forceEnd(5_000_000);
    expect(sessions).toHaveLength(0);
  });

  it('session payload has correct startedAt, endedAt, meanRps, peakRps', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 6_000_000;
    machine.onDip(t0);
    machine.onDip(t0 + 1_000);
    machine.onDip(t0 + 2_000);
    machine.onDip(t0 + 3_000);

    await vi.advanceTimersByTimeAsync(15_000);

    const s = sessions[0];
    expect(s).toBeDefined();
    expect(s?.startedAt).toBe(t0);
    expect(s?.rotations).toBe(4);
    expect(s?.meanRps).toBeGreaterThan(0);
    expect(s?.peakRps).toBeGreaterThan(0);
    expect(s?.peakRps).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it('multiple dips in the same second produce correct peakRps', async () => {
    vi.useFakeTimers();
    const sessions: ReturnType<typeof makeSession>[] = [];
    const machine = new TapeSessionMachine(1, (s) => sessions.push(s));

    const t0 = 7_000_000_000; // at a second boundary
    machine.onDip(t0);
    machine.onDip(t0 + 200);
    machine.onDip(t0 + 400);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(sessions[0]?.peakRps).toBe(3);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Narrator integration: synthetic dip sequence -> diary entry
// ---------------------------------------------------------------------------

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-tape-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  process.env['FRIGATE_URL'] = 'http://frigate:5000';
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workdir, { recursive: true, force: true });
  const resetConfig = () => import('../src/config.js').then((m) => m.resetConfigForTests());
  const resetDb = () => import('../src/db.js').then((m) => m.resetDbForTests());
  void Promise.all([resetConfig(), resetDb()]);
});

describe('narrator integration — tape session -> diary entry', () => {
  it('handleWheelTapeSession writes a diary entry with correct wheel_meters', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    // circumference_cm = 20cm → 10 rotations × 20/100 = 2.0m
    const cam = db.createCamera({
      name: 'tape-cam',
      emoji: '🎡',
      stream_url: 'rtsp://x/w',
      enabled: true,
      wheel_tape_circumference_cm: 20.0,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_800_000_000_000;
    const session = {
      cameraId: cam.id,
      startedAt: t0,
      endedAt: t0 + 10_000,
      rotations: 10,
      meanRps: 1.0,
      peakRps: 2.0,
    };

    const entry = await handleWheelTapeSession(session, {
      now: () => t0 + 10_000,
      rng: () => 0,
      onEntryWritten: async () => {},
    });

    expect(entry).not.toBeNull();
    expect(entry?.activity).toBe('wheel');
    expect(entry?.duration_ms).toBe(10_000);

    const details = JSON.parse(entry?.details ?? '{}') as Record<string, unknown>;
    expect(details['wheel_meters']).toBeCloseTo(2.0, 5);
    expect(details['rotations']).toBe(10);
    expect(details['mean_rps']).toBe(1.0);
    expect(details['peak_rps']).toBe(2.0);
    expect(typeof details['camera']).toBe('string');
  });

  it('dedupe: two sessions within WHEEL_DEDUPE_GAP_MS (5 min silence) merge with summed rotations', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    const cam = db.createCamera({
      name: 'tape-cam',
      emoji: '🎡',
      stream_url: 'rtsp://x/w',
      enabled: true,
      wheel_tape_circumference_cm: 13.0,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_800_100_000_000;
    // First session: 15 rotations, gap=12s to second start (within 5 min dedupe gap).
    const first = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 5_000, rotations: 15, meanRps: 3.0, peakRps: 5 },
      { now: () => t0 + 5_000, rng: () => 0, onEntryWritten: async () => {} },
    );
    expect(first).not.toBeNull();

    // Second session starts 12s after first ended — gap = 12s, well within 5 min.
    const t1 = t0 + 5_000 + 12_000;
    const merged = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t1, endedAt: t1 + 5_000, rotations: 15, meanRps: 3.0, peakRps: 4 },
      { now: () => t1 + 5_000, rng: () => 0, onEntryWritten: async () => {} },
    );

    expect(merged?.id).toBe(first?.id);

    const entries = db.listDiaryEntriesBetween(0, t0 + 1_000_000);
    expect(entries).toHaveLength(1);
    const det = JSON.parse(entries[0]!.details ?? '{}') as Record<string, unknown>;
    // (15 + 15) rotations × 13cm / 100 = 3.9m
    expect((det['wheel_meters'] as number)).toBeCloseTo(3.9, 4);
    expect(det['rotations']).toBe(30);
    expect(det['merged_sessions']).toBe(1);
    expect(det['peak_rps']).toBe(5);
  });

  it('zero-duration session is rejected (returns null)', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    const cam = db.createCamera({
      name: 'tape-cam', emoji: '🎡', stream_url: 'rtsp://x/w', enabled: true,
    });

    const t0 = 1_800_200_000_000;
    const entry = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0, rotations: 5, meanRps: 1.0, peakRps: 2 },
      { now: () => t0, rng: () => 0, onEntryWritten: async () => {} },
    );

    expect(entry).toBeNull();
  });

  it('uses default circumference (13cm) when column is absent / not set', async () => {
    const { handleWheelTapeSession, resetNarratorState } =
      await import('../src/narrator.js');
    const db = await import('../src/db.js');
    resetNarratorState();

    const cam = db.createCamera({
      name: 'tape-cam', emoji: '🎡', stream_url: 'rtsp://x/w', enabled: true,
    });
    db.setSetting('pet_name', 'Remy');

    const t0 = 1_800_300_000_000;
    const entry = await handleWheelTapeSession(
      { cameraId: cam.id, startedAt: t0, endedAt: t0 + 10_000, rotations: 10, meanRps: 1.0, peakRps: 2 },
      { now: () => t0 + 10_000, rng: () => 0, onEntryWritten: async () => {} },
    );

    const details = JSON.parse(entry?.details ?? '{}') as Record<string, unknown>;
    // 10 × 13 / 100 = 1.3m
    expect((details['wheel_meters'] as number)).toBeCloseTo(1.3, 5);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SessionType = Parameters<ConstructorParameters<typeof TapeSessionMachine>[1]>[0];
function makeSession(s: SessionType): SessionType {
  return s;
}
