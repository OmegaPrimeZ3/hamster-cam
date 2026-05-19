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

import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AuthGate } from './components/AuthGate';
import { Login } from './components/Login';
import { Header } from './components/Header';
import { StatsStrip } from './components/StatsStrip';
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
import { writeCachedBrand } from './components/Login';
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
  const settings = trpc.settings.get.useQuery();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('pet');
  const [changePwOpen, setChangePwOpen] = useState(false);

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
        <StatsStrip />
        <CameraGrid
          onAdminOpenCameras={isAdmin ? () => {
            setSettingsTab('cameras');
            setSettingsOpen(true);
          } : undefined}
        />
        <Diary
          readAloud={settings.data?.read_aloud ?? false}
          petName={settings.data?.pet_name ?? ''}
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
