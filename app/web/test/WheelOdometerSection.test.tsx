// app/web/test/WheelOdometerSection.test.tsx
//
// Covers:
//   (a) Section is open by default (Change A).
//   (b) Targeting feed button appears only when liveSrc is provided.
//   (c) Box overlay geometry (top/height/left/width) tracks all four config fields.
//   (d) X/width sliders fire onChange with updated values.
//
// Strategy: WheelOdometerSection calls trpc.cameras.testWheelDetection.useMutation()
// internally. renderWithProviders wraps the tree in the tRPC + React Query providers
// (using makeTrpcClient which points at localhost — no real network calls fire in
// tests because mutations only execute on user interaction). LiveStream is NOT mocked
// because the section only renders the targeting feed when targetingOpen=true, and
// we control that through user events; the custom element is stubbed the same way
// LiveStream.test.tsx does it to prevent jsdom from throwing.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import {
  WheelOdometerSection,
  WHEEL_CONFIG_DEFAULTS,
  type WheelConfig,
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
