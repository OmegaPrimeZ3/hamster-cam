// app/web/test/WheelOdometerSection.test.tsx
//
// Covers:
//   (a) Section is open by default (Change A).
//   (b) Targeting feed button appears only when liveSrc is provided.
//   (c) Box overlay geometry (top/height/left/width) tracks all four config fields.
//   (d) X/width sliders fire onChange with updated values.
//   (e) Test rotation count — button, duration picker, result display.
//   (f) RotationTestResult — primary readout, distance, frame stats, zero state.
//   (g) RatioSparkline — renders bars + threshold line; downsample math.
//
// Strategy: WheelOdometerSection calls trpc.cameras.testWheelDetection.useMutation()
// and trpc.cameras.testWheelRotation.useMutation() internally. renderWithProviders
// wraps the tree in the tRPC + React Query providers (using makeTrpcClient which
// points at localhost — no real network calls fire in tests because mutations only
// execute on user interaction). RotationTestResult and RatioSparkline are exported
// and rendered directly in isolation tests so we avoid needing to drive a full
// mutation round-trip for static display assertions.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, render } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import {
  WheelOdometerSection,
  WHEEL_CONFIG_DEFAULTS,
  type WheelConfig,
  RotationTestResult,
  RatioSparkline,
  downsample,
  type RotationTestResultProps,
} from '../src/components/WheelOdometerSection';

// Register the VideoRTC stub once so <video-rtc> does not throw in jsdom.
class VideoRTCStub extends HTMLElement {
  video: HTMLVideoElement | null = null;
  mode = 'webrtc,mse';
  media = 'video,audio';
  set src(_v: string) {}
  connectedCallback(): void {}
  disconnectedCallback(): void {}
}

beforeEach(() => {
  if (!customElements.get('video-rtc')) {
    customElements.define('video-rtc', VideoRTCStub);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSection(
  configOverrides: Partial<WheelConfig> = {},
  liveSrc?: string | null,
  onChange?: (next: WheelConfig) => void,
): void {
  const config: WheelConfig = { ...WHEEL_CONFIG_DEFAULTS, ...configOverrides };
  renderWithProviders(
    <WheelOdometerSection
      cameraId={42}
      config={config}
      onChange={onChange ?? (() => {})}
      liveSrc={liveSrc}
    />,
  );
}

// ---------------------------------------------------------------------------
// (a) Section open by default
// ---------------------------------------------------------------------------

describe('WheelOdometerSection — default open', () => {
  it('renders the body content without any user interaction', () => {
    renderSection();
    // The "Enable wheel odometer" checkbox is inside the body — it must be
    // visible immediately if the section defaults to open.
    expect(screen.getByRole('checkbox', { name: /enable wheel odometer/i })).toBeInTheDocument();
  });

  it('header button has aria-expanded=true on first render', () => {
    renderSection();
    const toggle = screen.getByRole('button', { name: /wheel odometer/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses when the header is clicked', () => {
    renderSection();
    const toggle = screen.getByRole('button', { name: /wheel odometer/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox', { name: /enable wheel odometer/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (b) Targeting feed button visibility
// ---------------------------------------------------------------------------

describe('WheelOdometerSection — targeting feed button visibility', () => {
  it('shows the targeting feed button when liveSrc is a non-empty string', () => {
    renderSection({}, 'hamster_cam_1');
    expect(screen.getByRole('button', { name: /targeting feed/i })).toBeInTheDocument();
  });

  it('does NOT show the targeting feed button when liveSrc is null', () => {
    renderSection({}, null);
    expect(screen.queryByRole('button', { name: /targeting feed/i })).not.toBeInTheDocument();
  });

  it('does NOT show the targeting feed button when liveSrc is undefined', () => {
    renderSection({}, undefined);
    expect(screen.queryByRole('button', { name: /targeting feed/i })).not.toBeInTheDocument();
  });

  it('does NOT show the targeting feed button when liveSrc is an empty string', () => {
    renderSection({}, '');
    expect(screen.queryByRole('button', { name: /targeting feed/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (c) Band overlay geometry tracks config sliders
// ---------------------------------------------------------------------------

describe('WheelOdometerSection — band overlay geometry', () => {
  it('overlay is not rendered while the targeting feed is hidden', () => {
    renderSection({ wheel_band_y_pct: 30, wheel_band_height_pct: 15 }, 'hamster_cam_1');
    expect(screen.queryByTestId('targeting-band-overlay')).not.toBeInTheDocument();
  });

  it('overlay appears with correct top/height styles after opening the targeting feed', () => {
    renderSection({ wheel_band_y_pct: 35, wheel_band_height_pct: 12 }, 'hamster_cam_1');

    const targetingBtn = screen.getByRole('button', { name: /targeting feed/i });
    fireEvent.click(targetingBtn);

    const overlay = screen.getByTestId('targeting-band-overlay');
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveStyle({ top: '35%', height: '12%' });
  });

  it('overlay top reflects wheel_band_y_pct=0', () => {
    renderSection({ wheel_band_y_pct: 0, wheel_band_height_pct: 5 }, 'hamster_cam_1');
    fireEvent.click(screen.getByRole('button', { name: /targeting feed/i }));
    expect(screen.getByTestId('targeting-band-overlay')).toHaveStyle({ top: '0%' });
  });

  it('overlay top reflects wheel_band_y_pct=100', () => {
    renderSection({ wheel_band_y_pct: 100, wheel_band_height_pct: 1 }, 'hamster_cam_1');
    fireEvent.click(screen.getByRole('button', { name: /targeting feed/i }));
    expect(screen.getByTestId('targeting-band-overlay')).toHaveStyle({ top: '100%' });
  });

  it('overlay height reflects wheel_band_height_pct=50', () => {
    renderSection({ wheel_band_y_pct: 20, wheel_band_height_pct: 50 }, 'hamster_cam_1');
    fireEvent.click(screen.getByRole('button', { name: /targeting feed/i }));
    expect(screen.getByTestId('targeting-band-overlay')).toHaveStyle({ height: '50%' });
  });

  it('toggle button changes label to "Hide targeting feed" when open', () => {
    renderSection({}, 'hamster_cam_1');
    const btn = screen.getByRole('button', { name: /targeting feed/i });
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: /hide targeting feed/i })).toBeInTheDocument();
  });

  it('overlay left reflects wheel_band_x_pct=20', () => {
    renderSection({ wheel_band_x_pct: 20, wheel_band_width_pct: 40 }, 'hamster_cam_1');
    fireEvent.click(screen.getByRole('button', { name: /targeting feed/i }));
    expect(screen.getByTestId('targeting-band-overlay')).toHaveStyle({ left: '20%' });
  });

  it('overlay width reflects wheel_band_width_pct=40', () => {
    renderSection({ wheel_band_x_pct: 20, wheel_band_width_pct: 40 }, 'hamster_cam_1');
    fireEvent.click(screen.getByRole('button', { name: /targeting feed/i }));
    expect(screen.getByTestId('targeting-band-overlay')).toHaveStyle({ width: '40%' });
  });

  it('overlay left reflects wheel_band_x_pct=0 (default full-width)', () => {
    renderSection({ wheel_band_x_pct: 0, wheel_band_width_pct: 100 }, 'hamster_cam_1');
    fireEvent.click(screen.getByRole('button', { name: /targeting feed/i }));
    const overlay = screen.getByTestId('targeting-band-overlay');
    expect(overlay).toHaveStyle({ left: '0%', width: '100%' });
  });

  it('overlay label reads "detection box"', () => {
    renderSection({}, 'hamster_cam_1');
    fireEvent.click(screen.getByRole('button', { name: /targeting feed/i }));
    const overlay = screen.getByTestId('targeting-band-overlay');
    expect(overlay.textContent?.toLowerCase()).toContain('detection box');
  });
});

// ---------------------------------------------------------------------------
// (d) X/width sliders fire onChange with updated values
// ---------------------------------------------------------------------------

describe('WheelOdometerSection — X/width slider onChange', () => {
  it('X slider fires onChange with updated wheel_band_x_pct', () => {
    const handler = vi.fn();
    renderSection({ wheel_band_x_pct: 10 }, undefined, handler);
    const slider = screen.getByRole('slider', { name: /detection box x position/i });
    fireEvent.change(slider, { target: { value: '25' } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ wheel_band_x_pct: 25 });
  });

  it('width slider fires onChange with updated wheel_band_width_pct', () => {
    const handler = vi.fn();
    renderSection({ wheel_band_width_pct: 80 }, undefined, handler);
    const slider = screen.getByRole('slider', { name: /detection box width/i });
    fireEvent.change(slider, { target: { value: '50' } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ wheel_band_width_pct: 50 });
  });
});

// ---------------------------------------------------------------------------
// (e) Test rotation count — button + duration picker inside WheelOdometerSection
// ---------------------------------------------------------------------------

describe('WheelOdometerSection — Test rotation count button', () => {
  it('renders the "Test rotation count" button', () => {
    renderSection();
    expect(
      screen.getByRole('button', { name: /test rotation count/i }),
    ).toBeInTheDocument();
  });

  it('renders duration picker buttons with labels 10s, 15s, 30s', () => {
    renderSection();
    expect(screen.getByRole('button', { name: '10s' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '15s' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30s' })).toBeInTheDocument();
  });

  it('defaults to 15s selected (aria-pressed=true)', () => {
    renderSection();
    expect(screen.getByRole('button', { name: '15s' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '10s' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: '30s' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('clicking 30s makes it selected and deselects 15s', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: '30s' }));
    expect(screen.getByRole('button', { name: '30s' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '15s' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('clicking 10s makes it selected', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: '10s' }));
    expect(screen.getByRole('button', { name: '10s' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('"Sample duration" group has an accessible label', () => {
    renderSection();
    expect(
      screen.getByRole('group', { name: /sample duration/i }),
    ).toBeInTheDocument();
  });

  it('"Test rotation count" button has an aria-label mentioning the duration', () => {
    renderSection();
    const btn = screen.getByRole('button', { name: /test rotation count over 15 seconds/i });
    expect(btn).toBeInTheDocument();
  });

  it('aria-label on the run button updates when duration changes to 30s', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: '30s' }));
    expect(
      screen.getByRole('button', { name: /test rotation count over 30 seconds/i }),
    ).toBeInTheDocument();
  });

  it('help text is present below the rotation test controls', () => {
    renderSection();
    expect(
      screen.getByText(/runs a live sample and counts full wheel rotations/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (f) RotationTestResult — isolated rendering
// ---------------------------------------------------------------------------

const SAMPLE_RESULT: RotationTestResultProps['result'] = {
  rotations: 7,
  sampledDurationS: 15,
  sampleFps: 10.0,
  framesSampled: 150,
  ratioTrace: [0.1, 0.8, 0.1, 0.9, 0.1, 0.8, 0.1],
  thresholdRatio: 0.5,
  distanceMeters: 3.341,
  diameterMm: 152,
};

describe('RotationTestResult — non-zero rotation', () => {
  it('renders the rotation count in large text', () => {
    render(<RotationTestResult result={SAMPLE_RESULT} distanceUnit="mi" />);
    expect(screen.getByLabelText(/7 rotations counted/i)).toBeInTheDocument();
  });

  it('renders "rotations" label text', () => {
    render(<RotationTestResult result={SAMPLE_RESULT} distanceUnit="mi" />);
    expect(screen.getByText('rotations')).toBeInTheDocument();
  });

  it('renders formatted distance in miles', () => {
    render(<RotationTestResult result={SAMPLE_RESULT} distanceUnit="mi" />);
    // 3.341 m = 10.96 ft < 0.1 mi → "11 ft"
    expect(screen.getByLabelText(/distance 11 ft/i)).toBeInTheDocument();
  });

  it('renders formatted distance in km (metric)', () => {
    render(<RotationTestResult result={SAMPLE_RESULT} distanceUnit="km" />);
    // 3.341 m < 100 m → "3 m"
    expect(screen.getByLabelText(/distance 3 m/i)).toBeInTheDocument();
  });

  it('renders frames sampled, duration and fps small print', () => {
    render(<RotationTestResult result={SAMPLE_RESULT} distanceUnit="mi" />);
    expect(screen.getByText(/150 frames sampled over 15s @ 10\.0 fps/i)).toBeInTheDocument();
  });

  it('renders the ratio sparkline when ratioTrace is non-empty', () => {
    render(<RotationTestResult result={SAMPLE_RESULT} distanceUnit="mi" />);
    expect(screen.getByTestId('ratio-sparkline')).toBeInTheDocument();
  });

  it('does NOT show the zero-state message', () => {
    render(<RotationTestResult result={SAMPLE_RESULT} distanceUnit="mi" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('wraps result in the rotation-test-result container', () => {
    render(<RotationTestResult result={SAMPLE_RESULT} distanceUnit="mi" />);
    expect(screen.getByTestId('rotation-test-result')).toBeInTheDocument();
  });
});

describe('RotationTestResult — singular rotation label', () => {
  it('says "rotation" (singular) for exactly 1 rotation', () => {
    const singleRotation = { ...SAMPLE_RESULT, rotations: 1, distanceMeters: 0.477 };
    render(<RotationTestResult result={singleRotation} distanceUnit="mi" />);
    expect(screen.getByText('rotation')).toBeInTheDocument();
    expect(screen.queryByText('rotations')).not.toBeInTheDocument();
  });
});

describe('RotationTestResult — zero rotations', () => {
  const zeroResult: RotationTestResultProps['result'] = {
    ...SAMPLE_RESULT,
    rotations: 0,
    distanceMeters: 0,
    ratioTrace: [0.1, 0.2, 0.15, 0.1],
  };

  it('renders zero in large text', () => {
    render(<RotationTestResult result={zeroResult} distanceUnit="mi" />);
    expect(screen.getByLabelText(/0 rotations counted/i)).toBeInTheDocument();
  });

  it('does NOT render the distance span when rotations is 0', () => {
    render(<RotationTestResult result={zeroResult} distanceUnit="mi" />);
    // The aria-label for distance is only rendered when !isZero.
    expect(screen.queryByLabelText(/^distance/i)).not.toBeInTheDocument();
  });

  it('shows the zero-state explanation message', () => {
    render(<RotationTestResult result={zeroResult} distanceUnit="mi" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toMatch(/no rotations detected/i);
  });

  it('zero-state message directs user to the detection test', () => {
    render(<RotationTestResult result={zeroResult} distanceUnit="mi" />);
    expect(screen.getByRole('status').textContent).toMatch(/test detection/i);
  });

  it('still renders sparkline even at zero rotations when trace is non-empty', () => {
    render(<RotationTestResult result={zeroResult} distanceUnit="mi" />);
    expect(screen.getByTestId('ratio-sparkline')).toBeInTheDocument();
  });

  it('does NOT render sparkline when ratioTrace is empty', () => {
    const emptyTrace = { ...zeroResult, ratioTrace: [] as number[] };
    render(<RotationTestResult result={emptyTrace} distanceUnit="mi" />);
    expect(screen.queryByTestId('ratio-sparkline')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (g) RatioSparkline — SVG structure + threshold line + downsample math
// ---------------------------------------------------------------------------

describe('RatioSparkline — SVG rendering', () => {
  it('renders an SVG with role=img', () => {
    render(<RatioSparkline trace={[0.1, 0.8, 0.2]} threshold={0.5} />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('aria-label mentions the number of data points', () => {
    render(<RatioSparkline trace={[0.1, 0.8, 0.2]} threshold={0.5} />);
    const svg = screen.getByTestId('ratio-sparkline');
    expect(svg).toHaveAttribute('aria-label', expect.stringContaining('3 data points'));
  });

  it('aria-label mentions the threshold percentage', () => {
    render(<RatioSparkline trace={[0.1, 0.8]} threshold={0.4} />);
    const svg = screen.getByTestId('ratio-sparkline');
    expect(svg).toHaveAttribute('aria-label', expect.stringContaining('40%'));
  });

  it('renders a threshold reference line', () => {
    render(<RatioSparkline trace={[0.1, 0.8, 0.9]} threshold={0.5} />);
    expect(screen.getByTestId('sparkline-threshold-line')).toBeInTheDocument();
  });

  it('threshold line y1 equals SPARKLINE_HEIGHT * (1 - threshold)', () => {
    // SPARKLINE_HEIGHT = 48; threshold = 0.5 → y = 24
    render(<RatioSparkline trace={[0.3, 0.7]} threshold={0.5} />);
    const line = screen.getByTestId('sparkline-threshold-line');
    expect(line).toHaveAttribute('y1', '24');
  });

  it('threshold line y1 at threshold=0.25 is 36 (= 48 * 0.75)', () => {
    render(<RatioSparkline trace={[0.3, 0.7]} threshold={0.25} />);
    const line = screen.getByTestId('sparkline-threshold-line');
    expect(line).toHaveAttribute('y1', '36');
  });

  it('label text includes the threshold percentage', () => {
    render(<RatioSparkline trace={[0.3]} threshold={0.6} />);
    expect(screen.getByText(/threshold line = 60%/i)).toBeInTheDocument();
  });

  it('explanatory text below sparkline is present', () => {
    render(<RatioSparkline trace={[0.3, 0.7]} threshold={0.5} />);
    expect(
      screen.getByText(/bars above the red dashed line = tape detected/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// downsample — pure unit tests
// ---------------------------------------------------------------------------

describe('downsample', () => {
  it('returns the original array when length <= maxLen', () => {
    const arr = [0.1, 0.5, 0.9];
    expect(downsample(arr, 10)).toEqual(arr);
    expect(downsample(arr, 3)).toEqual(arr);
  });

  it('returns array of length maxLen when input is longer', () => {
    const arr = Array.from({ length: 200 }, (_, i) => i / 200);
    const result = downsample(arr, 50);
    expect(result).toHaveLength(50);
  });

  it('each bucket value is the average of its input slice', () => {
    // Input: [0.0, 0.0, 1.0, 1.0] → 2 buckets of 2 → [0.0, 1.0]
    const result = downsample([0.0, 0.0, 1.0, 1.0], 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeCloseTo(0.0, 10);
    expect(result[1]).toBeCloseTo(1.0, 10);
  });

  it('averages correctly for a known mixed trace', () => {
    // [0.2, 0.4, 0.6, 0.8] → 2 buckets → [0.3, 0.7]
    const result = downsample([0.2, 0.4, 0.6, 0.8], 2);
    expect(result[0]).toBeCloseTo(0.3, 5);
    expect(result[1]).toBeCloseTo(0.7, 5);
  });

  it('handles an empty array', () => {
    expect(downsample([], 10)).toEqual([]);
  });

  it('handles maxLen=1 — collapses entire array to a single average', () => {
    const result = downsample([0.0, 0.5, 1.0], 1);
    expect(result).toHaveLength(1);
    // average of [0, 0.5, 1.0] = 0.5
    expect(result[0]).toBeCloseTo(0.5, 5);
  });
});
