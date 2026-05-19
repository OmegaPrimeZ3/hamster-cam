// app/web/test/theme.test.ts
//
// Theme palette + mode application, persistence, system-preference resolution.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  getPalette,
  PALETTES,
  persist,
  readPersisted,
  resolveMode,
} from '../src/theme';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-mode');
    // Reset inline styles set by applyTheme
    for (const v of ['--bg', '--surface', '--accent', '--text', '--text-muted', '--surface-raised', '--accent-text', '--border', '--success', '--warning', '--danger']) {
      document.documentElement.style.removeProperty(v);
    }
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('exposes six palettes with paired light/dark variants', () => {
    expect(PALETTES).toHaveLength(6);
    for (const p of PALETTES) {
      expect(p.light.bg).toBeTruthy();
      expect(p.dark.bg).toBeTruthy();
    }
  });

  it('applyTheme writes data-theme and data-mode on <html>', () => {
    applyTheme({ palette: 'forest', mode: 'dark' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('forest');
    expect(document.documentElement.getAttribute('data-mode')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe(getPalette('forest').dark.bg);
  });

  it('applyTheme switches from light to dark on the same palette', () => {
    applyTheme({ palette: 'galaxy', mode: 'light' });
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe(getPalette('galaxy').light.bg);
    applyTheme({ palette: 'galaxy', mode: 'dark' });
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe(getPalette('galaxy').dark.bg);
  });

  it('resolveMode collapses auto using systemPrefersDark', () => {
    expect(resolveMode('light', false)).toBe('light');
    expect(resolveMode('light', true)).toBe('light');
    expect(resolveMode('dark', false)).toBe('dark');
    expect(resolveMode('auto', true)).toBe('dark');
    expect(resolveMode('auto', false)).toBe('light');
  });

  it('persist + readPersisted round-trips palette and mode', () => {
    persist('ocean', 'dark');
    const got = readPersisted();
    expect(got).toEqual({ palette: 'ocean', mode: 'dark' });
  });

  it('readPersisted survives a corrupt cache', () => {
    localStorage.setItem('hc.theme', '{bad json');
    expect(readPersisted()).toBeNull();
  });

  it('readPersisted normalizes unknown palette to a sane default', () => {
    localStorage.setItem('hc.theme', JSON.stringify({ palette: 'made-up', mode: 'dark' }));
    expect(readPersisted()).toEqual({ palette: 'bubblegum', mode: 'dark' });
  });
});
