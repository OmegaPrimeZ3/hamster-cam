#!/usr/bin/env node
// app/web/scripts/build-icons.mjs
//
// Wraps pwa-asset-generator to emit the icon + splash set, then RE-WRITES
// public/manifest.json and re-syncs index.html so we keep ownership of those
// files (pwa-asset-generator's --manifest flag mangles paths). The names of
// the emitted icon files are normalized to the ones referenced by index.html.

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const iconsDir = path.join(root, 'public', 'icons');
const manifestPath = path.join(root, 'public', 'manifest.json');

const sourceSvg = path.join(iconsDir, 'source', 'mascot.svg');

async function main() {
  await fs.mkdir(iconsDir, { recursive: true });

  const args = [
    sourceSvg,
    iconsDir,
    '--opaque', 'false',
    '--padding', '12%',
    '--background', '#FFF1F5',
    '--type', 'png',
    '--quality', '90',
    '--maskable', 'true',
    '--favicon', 'false',
    '--no-sandbox',
    '--log', 'false',
    '--single-quotes', 'false',
  ];

  const result = spawnSync('npx', ['pwa-asset-generator', ...args], {
    stdio: 'inherit',
    cwd: root,
  });
  if (result.status !== 0) {
    throw new Error(`pwa-asset-generator exited ${result.status}`);
  }

  // Rename emitted files to the canonical names index.html expects.
  await renameIfExists(path.join(iconsDir, 'manifest-icon-192.maskable.png'), path.join(iconsDir, 'icon-192.png'));
  await renameIfExists(path.join(iconsDir, 'manifest-icon-512.maskable.png'), path.join(iconsDir, 'icon-512.png'));
  // The 512 maskable variant we keep separately so the manifest can declare it
  // with `purpose: "maskable"`. Re-emit by copying icon-512.png → icon-512-maskable.png
  // (the generator already padded for the safe-zone via --padding 12%).
  await copyIfExists(path.join(iconsDir, 'icon-512.png'), path.join(iconsDir, 'icon-512-maskable.png'));
  await renameIfExists(path.join(iconsDir, 'apple-icon-180.png'), path.join(iconsDir, 'apple-touch-icon.png'));

  // Rename splash images from the generator's naming (apple-splash-{w}-{h}.png)
  // to .jpg to match the index.html startup-image references.
  const entries = await fs.readdir(iconsDir);
  for (const name of entries) {
    if (name.startsWith('apple-splash-') && name.endsWith('.png')) {
      const target = name.replace(/\.png$/, '.jpg');
      const src = path.join(iconsDir, name);
      const dst = path.join(iconsDir, target);
      const data = await fs.readFile(src);
      await fs.writeFile(dst, data);
      await fs.unlink(src);
    }
  }

  // Re-write the canonical manifest with the correct icon paths.
  const manifest = {
    name: 'Hamster Cam',
    short_name: 'Hamster Cam',
    description: "A cozy live camera and activity diary for your family's small pet.",
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'landscape-primary',
    background_color: '#FFF1F5',
    theme_color: '#FFF1F5',
    lang: 'en',
    categories: ['lifestyle', 'kids'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // eslint-disable-next-line no-console
  console.log('Wrote', manifestPath);
}

async function renameIfExists(from, to) {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

async function copyIfExists(from, to) {
  try {
    const data = await fs.readFile(from);
    await fs.writeFile(to, data);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
