// app/web/test/WheelRecordsCard.test.tsx
//
// Tests for WheelRecordsCard's pure presentation layer (WheelRecordsContent).
// Rendering the presentation component directly avoids the AbortSignal issue
// that affects tRPC queries in jsdom — the same pattern used by DiaryEntry.test.tsx.
//
// Covers:
//   - Distance chips show correct formatted values for mi + km units
//   - Best-day and best-session highlights render when nonzero
//   - Best-day and best-session are hidden when zero
//   - Sparkline SVG is rendered when dailySeries is non-empty
//   - Sparkline is absent when dailySeries is empty
//   - "New record!" badge renders when showRecord=true
//   - "New record!" badge is absent when showRecord=false
//   - Section has accessible aria-label

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import {
  WheelRecordsContent,
  type WheelRecordsData,
} from '../src/components/WheelRecordsCard';

const BASE_DATA: WheelRecordsData = {
  todayMeters: 500,
  weekMeters: 3200,
  allTimeMeters: 15000,
  bestDayMeters: 1200,
  bestDayDate: '2026-05-20',
  bestSessionMeters: 800,
  dailySeries: [
    { date: '2026-05-20', meters: 1200 },
    { date: '2026-05-21', meters: 500 },
  ],
  todaySeconds: 480,
  weekSeconds: 3600,
  allTimeSeconds: 18000,
};

describe('WheelRecordsContent', () => {
  it('renders "Wheel Records" heading', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="mi" showRecord={false} />,
    );
    expect(screen.getByText('Wheel Records')).toBeInTheDocument();
  });

  it('renders "Today", "This week", "All time" chip labels', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="mi" showRecord={false} />,
    );
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('This week')).toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();
  });

  it('formats distances in imperial (mi) correctly', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="mi" showRecord={false} />,
    );
    // 500 m → 0.31 mi (500/1609.344 = 0.31, which is ≥ 0.1 mi threshold)
    expect(screen.getByText('0.31 mi')).toBeInTheDocument();
    // 3200 m → 1.99 mi
    expect(screen.getByText('1.99 mi')).toBeInTheDocument();
    // 15000 m → 9.32 mi
    expect(screen.getByText('9.32 mi')).toBeInTheDocument();
  });

  it('formats distances in metric (km) correctly', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="km" showRecord={false} />,
    );
    // 500 m → "500 m" (below 100 m→km threshold? No — above 100m threshold → km)
    // 500 m ≥ 100 m → 0.50 km
    expect(screen.getByText('0.50 km')).toBeInTheDocument();
    // 3200 m → 3.20 km
    expect(screen.getByText('3.20 km')).toBeInTheDocument();
    // 15000 m → 15.00 km
    expect(screen.getByText('15.00 km')).toBeInTheDocument();
  });

  it('shows best-day highlight with date when bestDayMeters > 0', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="mi" showRecord={false} />,
    );
    expect(screen.getByText(/Best day/i)).toBeInTheDocument();
    expect(screen.getByText(/2026-05-20/)).toBeInTheDocument();
  });

  it('shows best-session highlight when bestSessionMeters > 0', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="mi" showRecord={false} />,
    );
    expect(screen.getByText(/Best session/i)).toBeInTheDocument();
  });

  it('hides best-day highlight when bestDayMeters is 0', () => {
    renderWithProviders(
      <WheelRecordsContent
        data={{ ...BASE_DATA, bestDayMeters: 0, bestDayDate: null }}
        distanceUnit="mi"
        showRecord={false}
      />,
    );
    expect(screen.queryByText(/Best day/i)).not.toBeInTheDocument();
  });

  it('hides best-session highlight when bestSessionMeters is 0', () => {
    renderWithProviders(
      <WheelRecordsContent
        data={{ ...BASE_DATA, bestSessionMeters: 0 }}
        distanceUnit="mi"
        showRecord={false}
      />,
    );
    expect(screen.queryByText(/Best session/i)).not.toBeInTheDocument();
  });

  it('renders the sparkline SVG image when dailySeries is non-empty', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="mi" showRecord={false} />,
    );
    expect(screen.getByRole('img', { name: /14-day wheel distance sparkline/i })).toBeInTheDocument();
  });

  it('does not render the sparkline when dailySeries is empty', () => {
    renderWithProviders(
      <WheelRecordsContent
        data={{ ...BASE_DATA, dailySeries: [] }}
        distanceUnit="mi"
        showRecord={false}
      />,
    );
    expect(screen.queryByRole('img', { name: /sparkline/i })).not.toBeInTheDocument();
  });

  it('shows "New record!" badge when showRecord=true', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="mi" showRecord={true} />,
    );
    expect(screen.getByText(/New record!/i)).toBeInTheDocument();
  });

  it('does not show "New record!" badge when showRecord=false', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="mi" showRecord={false} />,
    );
    expect(screen.queryByText(/New record!/i)).not.toBeInTheDocument();
  });

  it('has an accessible section label "Wheel records"', () => {
    renderWithProviders(
      <WheelRecordsContent data={BASE_DATA} distanceUnit="mi" showRecord={false} />,
    );
    expect(screen.getByRole('region', { name: /wheel records/i })).toBeInTheDocument();
  });
});
