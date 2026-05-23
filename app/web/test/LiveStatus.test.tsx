// app/web/test/LiveStatus.test.tsx
//
// Tests for the LiveStatus feature.
//
// The StatusBar presentation component is tested directly (no tRPC needed).
// The currentStatusLine logic is tested in activity-style.test.ts.
// This file focuses on the rendering behaviour of StatusBar and integration
// of the live pip, reduced-motion flag, and text content.

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import { StatusBar } from '../src/components/LiveStatus';

describe('StatusBar (LiveStatus presentation)', () => {
  it('renders the emoji and text', () => {
    renderWithProviders(
      <StatusBar emoji="🎡" text="Remy is running on the wheel!" pip={false} reduced={false} />,
    );
    expect(screen.getByText('Remy is running on the wheel!')).toBeInTheDocument();
    expect(screen.getByText('🎡')).toBeInTheDocument();
  });

  it('renders the live pip when pip=true', () => {
    renderWithProviders(
      <StatusBar emoji="🎡" text="Remy is running on the wheel!" pip={true} reduced={false} />,
    );
    // The pip span is aria-hidden. Verify it's in the DOM via the container.
    // We use queryByText on the parent because aria-hidden elements are present in the DOM.
    const container = screen.getByText('Remy is running on the wheel!').closest('div');
    // The pip is a <span aria-hidden> sibling — verify it exists as a child.
    const pipSpan = container?.querySelector('[aria-hidden]');
    expect(pipSpan).not.toBeNull();
  });

  it('does NOT render the live pip when pip=false', () => {
    renderWithProviders(
      <StatusBar emoji="😴" text="Remy is having quiet time" pip={false} reduced={false} />,
    );
    // The pip span has a specific inline style; with pip=false it should be absent.
    // We verify by checking there's no span with a border-radius-50% pip inside the bar.
    const container = document.querySelector('[aria-live="polite"]');
    // pip=false → only the emoji span and text span. The pip span has boxShadow animation
    // — without pip there are only 2 aria-hidden children (emoji span has aria-hidden).
    // Simply verify the text is there and no extra pip-shaped element.
    expect(container?.querySelectorAll('[aria-hidden]')).toHaveLength(1); // only emoji
  });

  it('renders quiet-time line correctly', () => {
    renderWithProviders(
      <StatusBar emoji="😴" text="Remy is having quiet time" pip={false} reduced={false} />,
    );
    expect(screen.getByText('Remy is having quiet time')).toBeInTheDocument();
    expect(screen.getByText('😴')).toBeInTheDocument();
  });

  it('renders the stale fallback line', () => {
    renderWithProviders(
      <StatusBar
        emoji="🎡"
        text="Remy was last at the wheel · 4 min ago"
        pip={false}
        reduced={false}
      />,
    );
    expect(screen.getByText(/Remy was last at the wheel · 4 min ago/)).toBeInTheDocument();
  });

  it('is accessible — has aria-live="polite" and aria-atomic', () => {
    renderWithProviders(
      <StatusBar emoji="🐹" text="Remy is pottering about" pip={false} reduced={false} />,
    );
    const bar = document.querySelector('[aria-live="polite"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-atomic')).toBe('true');
  });
});
