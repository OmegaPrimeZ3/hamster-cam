// app/web/test/SwUpdateBanner.test.tsx
//
// Behavior tests for the service-worker update banner.
// The actual SW negotiation isn't testable in jsdom; we use the test-seam
// props `_testNeedRefresh` and `_testUpdate` to drive the component's
// rendered state without a real service worker.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SwUpdateBanner } from '../src/components/SwUpdateBanner';

describe('SwUpdateBanner — hidden when no update', () => {
  it('renders nothing when needRefresh is false', () => {
    const { container } = render(<SwUpdateBanner _testNeedRefresh={false} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('SwUpdateBanner — visible when update available', () => {
  it('shows the update banner when needRefresh is true', () => {
    render(<SwUpdateBanner _testNeedRefresh={true} _testUpdate={async () => undefined} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/a new version is available/i)).toBeInTheDocument();
  });

  it('renders "Update now" and dismiss buttons', () => {
    render(<SwUpdateBanner _testNeedRefresh={true} _testUpdate={async () => undefined} />);
    expect(screen.getByRole('button', { name: /update now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('calls updateServiceWorker(true) when "Update now" is clicked', () => {
    const mockUpdate = vi.fn().mockResolvedValue(undefined);
    render(<SwUpdateBanner _testNeedRefresh={true} _testUpdate={mockUpdate} />);
    fireEvent.click(screen.getByRole('button', { name: /update now/i }));
    expect(mockUpdate).toHaveBeenCalledWith(true);
  });

  it('hides the banner after clicking dismiss', () => {
    render(<SwUpdateBanner _testNeedRefresh={true} _testUpdate={async () => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
