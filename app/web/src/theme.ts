// app/web/src/theme.ts
//
// Six palette presets × {light, dark} = 12 CSS-variable bundles per PLAN §5.4.
// One source of truth — applied by setting `data-theme="..."` on <html> and
// (for dark) toggling the `data-mode="dark"` attribute as well.
//
// CSS custom properties are mutated imperatively on the <html> element, which
// keeps the CSS file free of @media or :root selectors per palette. All the
// variants live here as data.
//
// Public API:
//   - PALETTES: readonly registry of all six themes (with metadata for the
//     onboarding wizard + Pet settings)
//   - applyTheme(name, mode, prefersDark): mutates the document
//   - resolveMode(setting, systemPrefersDark): collapses 'auto' to light/dark
//   - listenToSystemTheme(cb): subscribes to prefers-color-scheme changes
//   - readPersisted(): pulls last-applied state from localStorage (so we
//     paint the right colors before /settings.get resolves on page load)
//   - persist(name, mode): writes that state for next paint

export type PaletteName = 'bubblegum' | 'forest' | 'ocean' | 'sunset' | 'galaxy' | 'sunshine';
export type ThemeModeSetting = 'light' | 'dark' | 'auto';
export type ResolvedMode = 'light' | 'dark';

export interface PaletteSwatches {
  bg: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  border: string;
  success: string;
  warning: string;
  danger: string;
}

export interface Palette {
  name: PaletteName;
  label: string;
  swatchPreview: string;
  light: PaletteSwatches;
  dark: PaletteSwatches;
}

const make = (
  name: PaletteName,
  label: string,
  swatchPreview: string,
  light: PaletteSwatches,
  dark: PaletteSwatches,
): Palette => ({ name, label, swatchPreview, light, dark });

export const PALETTES: readonly Palette[] = [
  make(
    'bubblegum',
    'Bubblegum',
    '#FF7AAF',
    {
      bg: '#FFF1F5',
      surface: '#FFFFFF',
      surfaceRaised: '#FFE4EE',
      text: '#2A1F2A',
      textMuted: '#6E5C68',
      accent: '#FF7AAF',
      accentText: '#FFFFFF',
      border: '#F4CFDD',
      success: '#3FB682',
      warning: '#E6A23C',
      danger: '#E0566B',
    },
    {
      bg: '#15131A',
      surface: '#231C24',
      surfaceRaised: '#2F2531',
      text: '#FCE5EE',
      textMuted: '#A6909C',
      accent: '#FF8FB9',
      accentText: '#1B0F16',
      border: '#3B2D38',
      success: '#67D2A1',
      warning: '#F0B768',
      danger: '#F0788B',
    },
  ),
  make(
    'forest',
    'Forest',
    '#5AA66A',
    {
      bg: '#F1F7F0',
      surface: '#FFFFFF',
      surfaceRaised: '#E3F0E1',
      text: '#1E2A1F',
      textMuted: '#5D6E5D',
      accent: '#5AA66A',
      accentText: '#FFFFFF',
      border: '#CCDFC9',
      success: '#3FB682',
      warning: '#E6A23C',
      danger: '#E0566B',
    },
    {
      bg: '#101510',
      surface: '#1B221C',
      surfaceRaised: '#252D26',
      text: '#E6F2E5',
      textMuted: '#9DAD9D',
      accent: '#7BC78C',
      accentText: '#10160F',
      border: '#2F3A2F',
      success: '#7AD7A6',
      warning: '#F0B768',
      danger: '#F0788B',
    },
  ),
  make(
    'ocean',
    'Ocean',
    '#3AA8C4',
    {
      bg: '#EFF6F9',
      surface: '#FFFFFF',
      surfaceRaised: '#DFEDF4',
      text: '#152330',
      textMuted: '#566B79',
      accent: '#3AA8C4',
      accentText: '#FFFFFF',
      border: '#C5DDE6',
      success: '#3FB682',
      warning: '#E6A23C',
      danger: '#E0566B',
    },
    {
      bg: '#0E141A',
      surface: '#192129',
      surfaceRaised: '#222C36',
      text: '#DFEEF5',
      textMuted: '#92A6B1',
      accent: '#65C7DD',
      accentText: '#091017',
      border: '#2A3742',
      success: '#67D2A1',
      warning: '#F0B768',
      danger: '#F0788B',
    },
  ),
  make(
    'sunset',
    'Sunset',
    '#FF8E5C',
    {
      bg: '#FFF3EC',
      surface: '#FFFFFF',
      surfaceRaised: '#FFE3D2',
      text: '#2A1A14',
      textMuted: '#705549',
      accent: '#FF8E5C',
      accentText: '#FFFFFF',
      border: '#F5CDBA',
      success: '#3FB682',
      warning: '#E6A23C',
      danger: '#E0566B',
    },
    {
      bg: '#161010',
      surface: '#231B1A',
      surfaceRaised: '#2E2422',
      text: '#FCEAE0',
      textMuted: '#AD9189',
      accent: '#FFA37A',
      accentText: '#1B0F0A',
      border: '#3B2E2A',
      success: '#67D2A1',
      warning: '#F0B768',
      danger: '#F0788B',
    },
  ),
  make(
    'galaxy',
    'Galaxy',
    '#8B6FE6',
    {
      bg: '#F2EEFB',
      surface: '#FFFFFF',
      surfaceRaised: '#E2D9F4',
      text: '#1E172E',
      textMuted: '#615A78',
      accent: '#8B6FE6',
      accentText: '#FFFFFF',
      border: '#D1C7EA',
      success: '#3FB682',
      warning: '#E6A23C',
      danger: '#E0566B',
    },
    {
      bg: '#100E1A',
      surface: '#1B1827',
      surfaceRaised: '#252134',
      text: '#EDE8FC',
      textMuted: '#9C97B6',
      accent: '#A593F0',
      accentText: '#0F0B1A',
      border: '#2E2A3D',
      success: '#67D2A1',
      warning: '#F0B768',
      danger: '#F0788B',
    },
  ),
  make(
    'sunshine',
    'Sunshine',
    '#F7CB36',
    {
      bg: '#FFFAEB',
      surface: '#FFFFFF',
      surfaceRaised: '#FFEDC5',
      text: '#2A2510',
      textMuted: '#7A6D45',
      accent: '#F7CB36',
      accentText: '#2A2510',
      border: '#F2D98A',
      success: '#3FB682',
      warning: '#E6A23C',
      danger: '#E0566B',
    },
    {
      bg: '#181510',
      surface: '#241F18',
      surfaceRaised: '#2F2820',
      text: '#FBF1DA',
      textMuted: '#B5A488',
      accent: '#FFDB6A',
      accentText: '#1A1408',
      border: '#3A3225',
      success: '#67D2A1',
      warning: '#F0B768',
      danger: '#F0788B',
    },
  ),
];

const PALETTE_BY_NAME: Map<PaletteName, Palette> = new Map(
  PALETTES.map((p) => [p.name, p] as const),
);

export function getPalette(name: string): Palette {
  return PALETTE_BY_NAME.get(name as PaletteName) ?? PALETTES[0]!;
}

const VAR_KEYS: Array<[keyof PaletteSwatches, string]> = [
  ['bg', '--bg'],
  ['surface', '--surface'],
  ['surfaceRaised', '--surface-raised'],
  ['text', '--text'],
  ['textMuted', '--text-muted'],
  ['accent', '--accent'],
  ['accentText', '--accent-text'],
  ['border', '--border'],
  ['success', '--success'],
  ['warning', '--warning'],
  ['danger', '--danger'],
];

export interface ApplyThemeArgs {
  palette: PaletteName;
  mode: ResolvedMode;
}

export function applyTheme({ palette, mode }: ApplyThemeArgs): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const swatches = getPalette(palette)[mode];
  for (const [key, cssVar] of VAR_KEYS) {
    root.style.setProperty(cssVar, swatches[key]);
  }
  root.setAttribute('data-theme', palette);
  root.setAttribute('data-mode', mode);
  // Keep <meta name="theme-color"> in step so iOS status bar follows.
  const meta = document.querySelector<HTMLMetaElement>(
    `meta[name="theme-color"]:not([media])`,
  );
  if (meta) meta.content = swatches.bg;
}

export function resolveMode(setting: ThemeModeSetting, systemPrefersDark: boolean): ResolvedMode {
  if (setting === 'light') return 'light';
  if (setting === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}

export function listenToSystemTheme(cb: (prefersDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {
      /* no-op on SSR / non-browser */
    };
  }
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}

const STORAGE_KEY = 'hc.theme';

interface PersistedTheme {
  palette: PaletteName;
  mode: ThemeModeSetting;
}

export function readPersisted(): PersistedTheme | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedTheme>;
    if (!parsed || typeof parsed.palette !== 'string') return null;
    const palette = PALETTE_BY_NAME.has(parsed.palette as PaletteName)
      ? (parsed.palette as PaletteName)
      : 'bubblegum';
    const mode: ThemeModeSetting =
      parsed.mode === 'light' || parsed.mode === 'dark' ? parsed.mode : 'auto';
    return { palette, mode };
  } catch {
    return null;
  }
}

export function persist(palette: PaletteName, mode: ThemeModeSetting): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ palette, mode }));
  } catch {
    /* quota / private-mode: harmless to drop */
  }
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
