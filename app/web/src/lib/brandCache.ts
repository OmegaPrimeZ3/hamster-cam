// app/web/src/lib/brandCache.ts
//
// Tiny localStorage cache for the pet name + emoji so returning browsers
// can display the correct branding instantly while settings.get revalidates.
//
// Written by AppShell (App.tsx) after each successful settings.get.
// Read by Login.tsx (splash) and Header.tsx / App.tsx (in-app surfaces).

export interface CachedBrand {
  petName: string;
  petEmoji: string;
}

export const BRAND_CACHE_KEY = 'hc.brand';

const DEFAULT_BRAND: CachedBrand = { petName: '', petEmoji: '🐾' };

export function readCachedBrand(): CachedBrand {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_BRAND };
    const raw = localStorage.getItem(BRAND_CACHE_KEY);
    if (!raw) return { ...DEFAULT_BRAND };
    const parsed = JSON.parse(raw) as Partial<CachedBrand>;
    return {
      petName: typeof parsed.petName === 'string' ? parsed.petName : '',
      petEmoji:
        typeof parsed.petEmoji === 'string' && parsed.petEmoji
          ? parsed.petEmoji
          : '🐾',
    };
  } catch {
    return { ...DEFAULT_BRAND };
  }
}

export function writeCachedBrand(brand: CachedBrand): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(brand));
  } catch {
    /* ignore quota errors */
  }
}
