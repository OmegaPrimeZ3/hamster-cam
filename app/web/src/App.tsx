// app/web/src/App.tsx
//
// App shell. Routes:
//   /login   - public, Login component
//   /        - AuthGate → main app
//
// Inside the AuthGate, we run:
//   - SettingsThemeBridge (applies user-chosen palette + mode reactively)
//   - OnboardingWizard (if admin and onboarding incomplete)
//   - Header + StatsStrip + CameraGrid + Diary
//   - BadgePopover (global)
//   - SettingsDrawer (admin-only)

import { useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AuthGate } from './components/AuthGate';
import { Login } from './components/Login';
import { Header } from './components/Header';
import { LiveStatus } from './components/LiveStatus';
import { StatsStrip } from './components/StatsStrip';
import { WheelRecordsCard } from './components/WheelRecordsCard';
import { CameraGrid } from './components/CameraGrid';
import { Diary } from './components/Diary';
import { BadgePopover } from './components/BadgePopover';
import { SettingsDrawer, SettingsTabId } from './components/SettingsDrawer';
import { OnboardingWizard } from './components/OnboardingWizard';
import { ChangePasswordForm } from './components/ChangePasswordForm';
import { trpc } from './trpc';
import { useAuth } from './hooks/useAuth';
import {
  PaletteName,
  ThemeModeSetting,
  applyTheme,
  listenToSystemTheme,
  persist,
  resolveMode,
  systemPrefersDark,
} from './theme';
import { readCachedBrand, writeCachedBrand } from './lib/brandCache';
import * as Dialog from '@radix-ui/react-dialog';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={
          <AuthGate>
            <AppShell />
          </AuthGate>
        }
      />
    </Routes>
  );
}

function AppShell(): JSX.Element {
  const { isAdmin } = useAuth();
  const utils = trpc.useUtils();
  const cachedBrand = useMemo(() => readCachedBrand(), []);
  // staleTime: treat a successful settings fetch as fresh for 60s so a
  // tab-switch doesn't fire a redundant re-fetch every time.
  // refetchInterval: if the initial fetch was missed or returned stale/error
  // data, the query re-attempts every 60s in the background so the app
  // self-heals without a manual page reload.
  const settings = trpc.settings.get.useQuery(undefined, {
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('pet');
  const [changePwOpen, setChangePwOpen] = useState(false);
  // Track whether the page was hidden so we only invalidate on true resume.
  const wasHiddenRef = useRef(document.visibilityState === 'hidden');

  // Theme reactivity — when settings.{theme, theme_mode} changes, apply.
  useEffect(() => {
    if (!settings.data) return;
    const palette = settings.data.theme as PaletteName;
    const mode: ThemeModeSetting = settings.data.theme_mode;
    const resolved = resolveMode(mode, systemPrefersDark());
    applyTheme({ palette, mode: resolved });
    persist(palette, mode);
    writeCachedBrand({ petName: settings.data.pet_name, petEmoji: settings.data.pet_emoji });
  }, [settings.data]);

  useEffect(() => {
    if (!settings.data) return undefined;
    const palette = settings.data.theme as PaletteName;
    const mode: ThemeModeSetting = settings.data.theme_mode;
    if (mode !== 'auto') return undefined;
    return listenToSystemTheme((prefersDark) => {
      applyTheme({ palette, mode: prefersDark ? 'dark' : 'light' });
    });
  }, [settings.data]);

  // Resume handling (Fix 3): when the PWA returns from background, invalidate
  // the settings and cameras queries so they immediately refetch rather than
  // waiting for the next scheduled interval. Combined with refetchOnWindowFocus
  // in the QueryClient default options this covers both tab-switch and
  // full app-backgrounding scenarios.
  useEffect(() => {
    function handleVisibilityChange(): void {
      if (document.visibilityState === 'visible' && wasHiddenRef.current) {
        void utils.settings.get.invalidate();
        void utils.cameras.list.invalidate();
      }
      wasHiddenRef.current = document.visibilityState === 'hidden';
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [utils]);

  // Run onboarding only for admins who haven't completed it yet.
  if (settings.data && isAdmin && !settings.data.onboarding_complete) {
    return <OnboardingWizard />;
  }

  return (
    <div className="hc-app">
      <Header
        onOpenSettings={() => {
          setSettingsTab('pet');
          setSettingsOpen(true);
        }}
        onOpenChangePassword={() => setChangePwOpen(true)}
      />

      <main className="hc-main" id="main">
        <LiveStatus petName={settings.data?.pet_name?.trim() || cachedBrand.petName} />
        <StatsStrip />
        <WheelRecordsCard />
        <CameraGrid
          onAdminOpenCameras={isAdmin ? () => {
            setSettingsTab('cameras');
            setSettingsOpen(true);
          } : undefined}
        />
        <Diary
          readAloud={settings.data?.read_aloud ?? false}
          petName={settings.data?.pet_name?.trim() || cachedBrand.petName}
        />
      </main>

      <BadgePopover />

      <SettingsDrawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
      />

      <ChangePasswordDialog open={changePwOpen} onOpenChange={setChangePwOpen} />
    </div>
  );
}

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60 }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(420px, calc(100vw - 24px))',
            padding: 22,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            color: 'var(--text)',
            zIndex: 61,
            boxShadow: '0 18px 36px rgba(0,0,0,0.18)',
          }}
        >
          <Dialog.Title className="display" style={{ marginTop: 0 }}>Change password</Dialog.Title>
          <ChangePasswordForm onClose={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
