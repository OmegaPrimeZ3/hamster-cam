// app/server/src/trpc.ts
// =====================================================================
// FROZEN CONTRACT — input/output shapes are final at tag `contract-v1`.
// Stage 2a may extend internals (procedure bodies) but the wire surface
// — Zod schemas on inputs and outputs — does not change without a
// contract bump per docs/EXECUTION.md.
// =====================================================================
//
// Three procedure builders:
//   publicProcedure    — unused; the public surface is the /auth/* REST routes
//   protectedProcedure — valid session, either role
//   adminProcedure     — role === 'admin', and audit-logs every mutation
//
// Read-only procedures across the board return zod-validated outputs so the
// frontend gets end-to-end inferred types via `inferRouterOutputs`.
// PLAN §5.4 (tRPC endpoints).

import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { z } from 'zod';

import { ensureClip } from './clips.js';
import { deleteFileBestEffort } from './fs-utils.js';
import { FfmpegError } from './frigate.js';
import { runDiskWatchJob } from './jobs/disk-watch.js';
import { runRetentionJob } from './jobs/retention.js';
import { runTimelapseJob } from './jobs/timelapse.js';
import { childLogger } from './logger.js';
import {
  getVapidPublicKey,
  sendPushToUser,
} from './push.js';
import { testWheelDetection, liveWheelRotationTest } from './wheel-odometer.js';

import * as db from './db.js';
import { resolveSession } from './session.js';
import * as frigate from './frigate.js';
import { triggerForgotPassword, registerAccount, ZyphrEmailTaken } from './zyphr.js';
import { saveManualSnapshot, getRecentEvents, getPetStatus, refreshNarratorTunings } from './narrator.js';
import { startShareJob } from './share.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AppContext {
  user: db.UserRow | null;
  sessionId: string | null;
  /** Fastify request — kept for handlers that need headers / IP. */
  req: CreateFastifyContextOptions['req'];
  res: CreateFastifyContextOptions['res'];
  /**
   * Per-request scratchpad. adminProcedure handlers that need a before-state
   * snapshot for audit-log details write it here (typically under key
   * `'before'`) and the audit resolver in `detailsFrom` reads it after the
   * mutation completes. Empty object on every request; never persists.
   */
  audit: Record<string, unknown>;
}

export function createContext(opts: CreateFastifyContextOptions): AppContext {
  const user = resolveSession(opts.req);
  return {
    user,
    sessionId: opts.req.sessionId ?? null,
    req: opts.req,
    res: opts.res,
    audit: {},
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const t = initTRPC.context<AppContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'unauthenticated' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * Admin procedure. Wraps the call in:
 *   - role check (403 for non-admins)
 *   - audit-log writer on success for mutations (we infer mutation-ness from
 *     the procedure type at build time via `meta`).
 *
 * Read-only admin procedures opt out by setting `meta({ audit: false })`.
 */
/**
 * Per-procedure audit-write configuration. Security-Review Finding 4
 * remediation: instead of always writing `target_id = null, details = null`,
 * we let each adminProcedure declare resolvers that read the affected row id
 * (and an optional details payload) from the procedure's input / result.
 *
 * Shapes the resolvers see:
 *   targetIdFrom(input, ctx)            — for "act on existing row" shapes
 *                                         where the id lives in the request.
 *   targetIdFromResult(result, ctx)     — for create-shaped procedures where
 *                                         the id only exists after `next()`.
 *   detailsFrom(input, result, ctx)     — arbitrary structured payload that
 *                                         gets JSON.stringify'd into the
 *                                         `details` audit-log column.
 *
 * The middleware calls these AFTER the inner procedure resolves (so create
 * resolvers see the new row, update resolvers see both the input and the
 * post-update result). Any resolver throwing → audit row is written with
 * whatever it produced before the throw (defensive: we never let an audit
 * resolver block the mutation it's auditing).
 */
interface AuditMetaConfig {
  /**
   * String overrides the default action label (which is the procedure path).
   * `false` disables audit-writing entirely — used by read-only admin routes.
   */
  action?: string | undefined;
  targetType?: string | undefined;
  targetIdFrom?: ((input: unknown, ctx: AppContext) => string | number | null | undefined) | undefined;
  targetIdFromResult?: ((
    result: unknown,
    input: unknown,
    ctx: AppContext,
  ) => string | number | null | undefined) | undefined;
  detailsFrom?: ((input: unknown, result: unknown, ctx: AppContext) => unknown) | undefined;
}

interface ProcedureMeta {
  /**
   * Audit configuration. `false` opts out entirely (read-only admin routes).
   * A bare string is the legacy shorthand for `{ action: '<string>' }` —
   * preserved so the broad migration to AuditMetaConfig doesn't churn every
   * existing call site at once.
   *
   * NEW shape (Finding 4): `{ action, targetType, targetIdFrom, ... }` so the
   * audit row carries the affected target_id and a JSON details payload.
   */
  audit?: false | string | AuditMetaConfig;
  /** Legacy: target_type column when `audit` is bare-string shorthand. */
  targetType?: string;
}

const tAdmin = initTRPC.context<AppContext>().meta<ProcedureMeta>().create();

export const adminProcedure = tAdmin.procedure.use(async ({
  ctx,
  next,
  path,
  type,
  meta,
  rawInput,
}) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'unauthenticated' });
  }
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'forbidden' });
  }

  const nextCtx = { ...ctx, user: ctx.user };
  const result = await next({ ctx: nextCtx });

  // Only audit successful mutations, and only when not explicitly opted out.
  if (type !== 'mutation' || !result.ok || meta?.audit === false) {
    return result;
  }

  // Resolve audit row fields out of either the legacy bare-string meta or the
  // new AuditMetaConfig object.
  const cfg: AuditMetaConfig = typeof meta?.audit === 'object' && meta.audit !== null
    ? meta.audit
    : {
        action: typeof meta?.audit === 'string' ? meta.audit : undefined,
        targetType: meta?.targetType,
      };

  // Resolvers are best-effort: a thrown resolver MUST NOT break the mutation
  // it's auditing. We just log nothing for that field.
  let targetId: string | null = null;
  try {
    if (cfg.targetIdFromResult) {
      const id = cfg.targetIdFromResult(result.data, rawInput, nextCtx);
      if (id !== null && id !== undefined) targetId = String(id);
    } else if (cfg.targetIdFrom) {
      const id = cfg.targetIdFrom(rawInput, nextCtx);
      if (id !== null && id !== undefined) targetId = String(id);
    }
  } catch {
    targetId = null;
  }

  let details: unknown = null;
  try {
    if (cfg.detailsFrom) {
      details = cfg.detailsFrom(rawInput, result.data, nextCtx);
    }
  } catch {
    details = null;
  }

  db.insertAudit({
    actor_user_id: ctx.user.id,
    action: cfg.action ?? path,
    target_type: cfg.targetType ?? null,
    target_id: targetId,
    details,
  });

  return result;
});

// ---------------------------------------------------------------------------
// Reusable Zod schemas (output projections that flow to the client)
// ---------------------------------------------------------------------------

const roleSchema = z.enum(['admin', 'child']);

const publicUserSchema = z.object({
  id: z.number().int(),
  email: z.string().email(),
  display_name: z.string(),
  role: roleSchema,
  created_at: z.number().int(),
  last_seen_at: z.number().int(),
});
export type PublicUserDTO = z.infer<typeof publicUserSchema>;

const cameraSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  emoji: z.string(),
  stream_url: z.string(),
  /** go2rtc stream name used by the /live/ws?src=<name> WebSocket proxy. Null until configured. */
  live_src: z.string().nullable(),
  position: z.number().int(),
  enabled: z.boolean(),
  created_at: z.number().int(),
  /** Operator-configured zone keywords for this camera (narrator vocabulary). */
  zones: z.array(z.string()),
  /** ms since epoch of Frigate's most recent frame; null = unknown. */
  last_frame_at: z.number().int().nullable(),
  /** Wheel odometer — whether optical mark detection is active. */
  wheel_mark_enabled: z.boolean(),
  /** Physical wheel diameter in millimetres. */
  wheel_diameter_mm: z.number(),
  /** Left edge of the ROI box as % of frame width (0–100). */
  wheel_band_x_pct: z.number(),
  /** ROI box width as % of frame width (0–100). */
  wheel_band_width_pct: z.number(),
  /** Centre of the sampling band as % of frame height (0–100). */
  wheel_band_y_pct: z.number(),
  /** Sampling band height as % of frame height (0–100). */
  wheel_band_height_pct: z.number(),
  /** Dark-pixel intensity cutoff as % (0–100). */
  wheel_threshold_pct: z.number(),
});
export type CameraDTO = z.infer<typeof cameraSchema>;

const diaryKindSchema = z.enum(['narrative', 'snapshot', 'timelapse', 'recap']);
const diaryActivitySchema = z.enum([
  'wheel', 'food', 'water', 'bathroom', 'resting', 'tunnel', 'exploring', 'hiding',
  'transition', 'snapshot', 'timelapse', 'recap',
]);

const diaryEntrySchema = z.object({
  id: z.number().int(),
  occurred_at: z.number().int(),
  kind: diaryKindSchema,
  activity: diaryActivitySchema.nullable(),
  narrative: z.string(),
  pet_name: z.string().nullable(),
  camera_id: z.number().int().nullable(),
  from_camera_id: z.number().int().nullable(),
  to_camera_id: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  snapshot_id: z.number().int().nullable(),
  media_path: z.string().nullable(),
  ai_model: z.string().nullable(),
  details: z.string().nullable(),
  created_by: z.number().int().nullable(),
  /** Relative-path URL to a ~480px JPEG thumbnail (e.g. `/thumbnails/entry-42-thumb.jpg`). */
  thumbnail_url: z.string().nullable(),
  /**
   * True when a playable clip can be produced for this entry:
   *   - clip_path is already cached on disk, OR
   *   - media_path ends with .mp4 (timelapse), OR
   *   - camera_id is set (Frigate extraction is possible).
   * False when none of the above apply — the frontend should hide "View Clip".
   */
  clip_available: z.boolean(),
});
export type DiaryEntryDTO = z.infer<typeof diaryEntrySchema>;

const badgeSchema = z.object({
  badge_id: z.string(),
  count: z.number().int(),
  first_earned_at: z.number().int(),
  last_earned_at: z.number().int(),
});
export type BadgeDTO = z.infer<typeof badgeSchema>;

const auditLogSchema = z.object({
  id: z.number().int(),
  actor_user_id: z.number().int().nullable(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  details: z.string().nullable(),
  at: z.number().int(),
});
export type AuditLogDTO = z.infer<typeof auditLogSchema>;

const recipientSchema = z.object({
  id: z.number().int(),
  display_name: z.string(),
  email: z.string().email(),
  added_by: z.number().int().nullable(),
  created_at: z.number().int(),
});
export type RecipientDTO = z.infer<typeof recipientSchema>;

const shareLogSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  recipient_id: z.number().int(),
  diary_entry_id: z.number().int(),
  status: z.enum(['queued', 'sent', 'failed']),
  sent_at: z.number().int().nullable(),
  error: z.string().nullable(),
  created_at: z.number().int(),
});
export type ShareLogDTO = z.infer<typeof shareLogSchema>;

// Mapper helpers — keep tRPC outputs decoupled from the raw row shapes so a
// future column addition doesn't accidentally leak through.

function cameraToDTO(row: db.CameraRow, lastFrameAt: number | null): CameraDTO {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    stream_url: row.stream_url,
    live_src: row.live_src ?? null,
    position: row.position,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    zones: row.zones,
    last_frame_at: lastFrameAt,
    wheel_mark_enabled: row.wheel_mark_enabled === 1,
    wheel_diameter_mm: row.wheel_diameter_mm,
    wheel_band_x_pct: row.wheel_band_x_pct,
    wheel_band_width_pct: row.wheel_band_width_pct,
    wheel_band_y_pct: row.wheel_band_y_pct,
    wheel_band_height_pct: row.wheel_band_height_pct,
    wheel_threshold_pct: row.wheel_threshold_pct,
  };
}

// Mirrors record.retain.days=10 in mac-mini/frigate-config.yml.
// Entries older than this window cannot have live footage pulled from Frigate;
// only already-extracted clip_path files or timelapse mp4s remain accessible.
// Update this constant if you change record.retain.days in Frigate's config.
const FRIGATE_RECORDING_RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

export function diaryToDTO(row: db.DiaryEntryRow): DiaryEntryDTO {
  // clip_available resolution order (mirrors ensureClip):
  //   1. Already extracted and cached on disk → always available regardless of age.
  //   2. Timelapse mp4 via media_path → always available regardless of age.
  //   3. camera_id set AND entry is recent enough for Frigate to still have footage.
  //      Entries older than FRIGATE_RECORDING_RETENTION_MS will 404 on Frigate
  //      and produce a doomed ffmpeg exit-1; suppress the button proactively.
  const hasExtractedClip = row.clip_path != null;
  const hasTimelapseMedia =
    row.media_path != null && row.media_path.toLowerCase().endsWith('.mp4');
  const withinRetentionWindow =
    row.camera_id != null &&
    Date.now() - row.occurred_at <= FRIGATE_RECORDING_RETENTION_MS;
  const clip_available = hasExtractedClip || hasTimelapseMedia || withinRetentionWindow;

  return {
    id: row.id,
    occurred_at: row.occurred_at,
    kind: row.kind,
    activity: row.activity,
    narrative: row.narrative,
    pet_name: row.pet_name,
    camera_id: row.camera_id,
    from_camera_id: row.from_camera_id,
    to_camera_id: row.to_camera_id,
    duration_ms: row.duration_ms,
    snapshot_id: row.snapshot_id,
    media_path: row.media_path,
    ai_model: row.ai_model ?? null,
    details: row.details ?? null,
    created_by: row.created_by ?? null,
    // Expose thumbnail as a browser-ready URL path; clip_path stays internal.
    thumbnail_url: row.thumbnail_path ? `/${row.thumbnail_path}` : null,
    clip_available,
  };
}

// ---------------------------------------------------------------------------
// settings.*
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  pet_name: z.string(),
  pet_emoji: z.string(),
  theme: z.string(),
  theme_mode: z.enum(['light', 'dark', 'auto']),
  read_aloud: z.boolean(),
  auto_rotate: z.boolean(),
  onboarding_complete: z.boolean(),
  snapshot_retention_days: z.number().int().nonnegative(),
  timelapse_retention_days: z.number().int().nonnegative(),
  audit_retention_days: z.number().int().nonnegative(),
  disk_warn_pct: z.number().int().min(0).max(100),
  disk_critical_pct: z.number().int().min(0).max(100),
  transition_window_ms: z.number().int().nonnegative(),
  min_dwell_ms: z.number().int().nonnegative(),
  /** Minimum dwell (ms) before an 'exploring' visit is written. Defaults to 60000 (1 min). */
  exploring_min_dwell_ms: z.number().int().nonnegative(),
  /** Whether cross-camera transition entries are written to the diary. Defaults to false. */
  transition_entries_enabled: z.boolean(),
  share_rate_limit_per_hour: z.number().int().nonnegative(),
  /** Distance unit for wheel odometer display. */
  distance_unit: z.enum(['mi', 'km']),
  /** Whether the nightly AI recap job is enabled. Defaults to true. */
  recap_enabled: z.boolean(),
  /** On/off gate for the nightly VIDEO timelapse job. Defaults to true. */
  timelapse_enabled: z.boolean(),
  /**
   * CSV of activity keywords in priority order for clip selection in the
   * timelapse job. Empty string = no override = current temporal behavior.
   * Valid tokens: wheel,food,water,bathroom,resting,tunnel,exploring,hiding.
   */
  recap_video_zone_priority: z.string(),
  /**
   * CSV of names for the AI recap greeting, e.g. "Maya,Leo".
   * Empty = no greeting (current behavior unchanged).
   */
  recap_names: z.string(),
});
export type SettingsDTO = z.infer<typeof settingsSchema>;

// Used to validate incoming partial updates.
const settingsUpdateSchema = settingsSchema.partial();

function parseSettingsKV(kv: db.SettingsKV): SettingsDTO {
  const get = (key: string, fallback: string): string => kv[key] ?? fallback;
  const num = (key: string, fallback: number): number => {
    const raw = kv[key];
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = kv[key];
    if (raw === undefined) return fallback;
    return raw === 'true' || raw === '1';
  };
  const mode = get('theme_mode', 'auto');
  const rawDistUnit = get('distance_unit', 'mi');
  return {
    pet_name: get('pet_name', ''),
    pet_emoji: get('pet_emoji', '🐾'),
    theme: get('theme', 'bubblegum'),
    theme_mode: mode === 'light' || mode === 'dark' ? mode : 'auto',
    read_aloud: bool('read_aloud', false),
    auto_rotate: bool('auto_rotate', false),
    onboarding_complete: bool('onboarding_complete', false),
    snapshot_retention_days: num('snapshot_retention_days', 90),
    timelapse_retention_days: num('timelapse_retention_days', 30),
    audit_retention_days: num('audit_retention_days', 365),
    disk_warn_pct: num('disk_warn_pct', 85),
    disk_critical_pct: num('disk_critical_pct', 95),
    transition_window_ms: num('transition_window_ms', 8000),
    min_dwell_ms: num('min_dwell_ms', 2000),
    exploring_min_dwell_ms: num('exploring_min_dwell_ms', 60000),
    transition_entries_enabled: bool('transition_entries_enabled', false),
    share_rate_limit_per_hour: num('share_rate_limit_per_hour', 10),
    distance_unit: rawDistUnit === 'km' ? 'km' : 'mi',
    recap_enabled: bool('recap_enabled', true),
    timelapse_enabled: bool('timelapse_enabled', true),
    recap_video_zone_priority: get('recap_video_zone_priority', ''),
    recap_names: get('recap_names', ''),
  };
}

const settingsRouter = router({
  // settings.get — either role reads
  get: protectedProcedure
    .input(z.void())
    .output(settingsSchema)
    .query(() => parseSettingsKV(db.getSettings())),

  // settings.update — admin only; written one key at a time
  update: adminProcedure
    .meta({
      audit: {
        action: 'settings.update',
        targetType: 'settings',
        // Settings is a singleton — there's no row id, but we record a stable
        // marker so audit consumers don't have to special-case null target_id.
        targetIdFrom: () => 'settings',
        // Build a before/after diff against the snapshot the mutation
        // captured into ctx.audit.before before calling setSettings.
        detailsFrom: (_input, result, ctx) => {
          const before = ctx.audit['before'];
          return diffObjects(
            isRecord(before) ? before : {},
            isRecord(result) ? result : {},
          );
        },
      },
    })
    .input(settingsUpdateSchema)
    .output(settingsSchema)
    .mutation(({ ctx, input }) => {
      // Capture the pre-update snapshot so the audit-detail resolver can build
      // the diff. Read from db.getSettings() not from `input` — input is a
      // partial; the snapshot needs the full state of every column the diff
      // might mention.
      ctx.audit['before'] = parseSettingsKV(db.getSettings());
      const kv: db.SettingsKV = {};
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        kv[key] = typeof value === 'boolean' ? String(value) : String(value);
      }
      db.setSettings(kv);
      // Propagate narrator-tuning changes immediately — no restart required.
      refreshNarratorTunings();
      return parseSettingsKV(db.getSettings());
    }),

  // settings.publicBrand — unauthenticated. Exposes ONLY the four branding
  // fields the login splash needs to paint the right pet name + colors.
  // SECURITY: output schema is exact and narrow — nothing else leaks.
  publicBrand: publicProcedure
    .input(z.void())
    .output(
      z.object({
        pet_name: z.string().nullable(),
        pet_emoji: z.string().nullable(),
        theme: z.string(),
        theme_mode: z.enum(['light', 'dark', 'auto']),
      }),
    )
    .query(() => {
      const s = parseSettingsKV(db.getSettings());
      return {
        pet_name: s.pet_name === '' ? null : s.pet_name,
        pet_emoji: s.pet_emoji === '' ? null : s.pet_emoji,
        theme: s.theme,
        theme_mode: s.theme_mode,
      };
    }),
});

// ---------------------------------------------------------------------------
// cameras.*
// ---------------------------------------------------------------------------

const camerasRouter = router({
  // List + last_frame_at per camera. Uses the background stats poller cache so
  // this resolves synchronously in microseconds — no Frigate network round-trip
  // in the request path. If Frigate is unreachable the cache entry is absent and
  // getCachedCameraStats falls back to the MQTT heartbeat, yielding null when
  // both are unavailable — the frontend renders the napping/offline state.
  list: protectedProcedure
    .input(z.void())
    .output(z.array(cameraSchema))
    .query(() => {
      const rows = db.listCameras();
      return rows.map((row): CameraDTO => {
        const stats = frigate.getCachedCameraStats(row.live_src ?? row.name);
        return cameraToDTO(row, stats.lastFrameAt);
      });
    }),

  create: adminProcedure
    .meta({
      audit: {
        action: 'cameras.create',
        targetType: 'camera',
        // Newly-created row id only exists post-mutation, so read from result.
        targetIdFromResult: (result) =>
          isRecord(result) && typeof result['id'] === 'number' ? result['id'] : null,
        detailsFrom: (input) => {
          if (!isRecord(input)) return null;
          return {
            name: input['name'],
            emoji: input['emoji'],
            stream_url: input['stream_url'],
            live_src: input['live_src'],
            enabled: input['enabled'],
          };
        },
      },
    })
    .input(z.object({
      name: z.string().min(1).max(60),
      emoji: z.string().max(8).default('📷'),
      stream_url: z.string().default(''),
      live_src: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'live_src may only contain letters, digits, hyphens, and underscores').max(64).nullable().default(null),
      enabled: z.boolean().default(true),
      zones: z.array(z.string()).default([]),
    }))
    .output(cameraSchema)
    .mutation(({ input }) => {
      const row = db.createCamera({
        name: input.name,
        emoji: input.emoji,
        stream_url: input.stream_url,
        live_src: input.live_src,
        enabled: input.enabled,
        zones: input.zones,
      });
      return cameraToDTO(row, null);
    }),

  update: adminProcedure
    .meta({
      audit: {
        action: 'cameras.update',
        targetType: 'camera',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        detailsFrom: (_input, result, ctx) => {
          const before = ctx.audit['before'];
          return diffObjects(
            isRecord(before) ? before : {},
            isRecord(result) ? result : {},
          );
        },
      },
    })
    .input(z.object({
      id: z.number().int(),
      name: z.string().min(1).max(60),
      emoji: z.string().max(8),
      stream_url: z.string().default(''),
      live_src: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'live_src may only contain letters, digits, hyphens, and underscores').max(64).nullable().optional(),
      enabled: z.boolean(),
      zones: z.array(z.string()).default([]),
      // Wheel odometer — optional; existing values are preserved when omitted.
      wheel_mark_enabled: z.boolean().optional(),
      wheel_diameter_mm: z.number().positive().optional(),
      wheel_band_x_pct: z.number().min(0).max(100).optional(),
      wheel_band_width_pct: z.number().min(0.1).max(100).optional(),
      wheel_band_y_pct: z.number().min(0).max(100).optional(),
      wheel_band_height_pct: z.number().min(0.1).max(100).optional(),
      wheel_threshold_pct: z.number().min(0).max(100).optional(),
    }))
    .output(cameraSchema)
    .mutation(({ ctx, input }) => {
      const before = db.getCameraById(input.id);
      if (before) ctx.audit['before'] = cameraToDTO(before, null);
      const row = db.updateCamera({
        id: input.id,
        name: input.name,
        emoji: input.emoji,
        stream_url: input.stream_url,
        // `input.live_src` is `string | null | undefined` (Zod optional nullable).
        // `undefined` means "not provided — preserve existing" which updateCamera handles.
        // We narrow to `string | null` when defined, else omit the key entirely.
        ...(input.live_src !== undefined ? { live_src: input.live_src } : {}),
        enabled: input.enabled,
        zones: input.zones,
        ...(input.wheel_mark_enabled !== undefined && { wheel_mark_enabled: input.wheel_mark_enabled }),
        ...(input.wheel_diameter_mm !== undefined && { wheel_diameter_mm: input.wheel_diameter_mm }),
        ...(input.wheel_band_x_pct !== undefined && { wheel_band_x_pct: input.wheel_band_x_pct }),
        ...(input.wheel_band_width_pct !== undefined && { wheel_band_width_pct: input.wheel_band_width_pct }),
        ...(input.wheel_band_y_pct !== undefined && { wheel_band_y_pct: input.wheel_band_y_pct }),
        ...(input.wheel_band_height_pct !== undefined && { wheel_band_height_pct: input.wheel_band_height_pct }),
        ...(input.wheel_threshold_pct !== undefined && { wheel_threshold_pct: input.wheel_threshold_pct }),
      });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'camera not found' });
      return cameraToDTO(row, null);
    }),

  delete: adminProcedure
    .meta({
      audit: {
        action: 'cameras.delete',
        targetType: 'camera',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        // Capture the deleted row's identity so the audit reviewer can see
        // what was removed (the row itself is gone by the time they look).
        detailsFrom: (_input, _result, ctx) => {
          const before = ctx.audit['before'];
          if (!isRecord(before)) return null;
          return { name: before['name'], stream_url: before['stream_url'] };
        },
      },
    })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      const before = db.getCameraById(input.id);
      if (before) ctx.audit['before'] = cameraToDTO(before, null);
      db.deleteCamera(input.id);
      return { ok: true } as const;
    }),

  reorder: adminProcedure
    .meta({
      audit: {
        action: 'cameras.reorder',
        targetType: 'camera',
        // Reorder hits every row — no single target_id is meaningful, so we
        // surface the ordered list as the audit-detail payload instead.
        detailsFrom: (input) => {
          if (!isRecord(input)) return null;
          const ids = input['ordered_ids'];
          return Array.isArray(ids) ? { ordered_ids: ids } : null;
        },
      },
    })
    .input(z.object({ ordered_ids: z.array(z.number().int()).min(1) }))
    .output(z.array(cameraSchema))
    .mutation(({ input }) => {
      db.reorderCameras(input.ordered_ids);
      return db.listCameras().map((row) => cameraToDTO(row, null));
    }),

  /**
   * Flip a single camera's enabled flag without touching any other field.
   * Designed for a one-tap toggle in the Settings camera list.
   */
  setEnabled: adminProcedure
    .meta({
      audit: {
        action: 'cameras.setEnabled',
        targetType: 'camera',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        detailsFrom: (input) => {
          if (!isRecord(input)) return null;
          return { id: input['id'], enabled: input['enabled'] };
        },
      },
    })
    .input(z.object({ id: z.number().int(), enabled: z.boolean() }))
    .output(cameraSchema)
    .mutation(({ input }) => {
      const row = db.setCameraEnabled(input.id, input.enabled);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'camera not found' });
      const stats = frigate.getCachedCameraStats(row.live_src ?? row.name);
      return cameraToDTO(row, stats.lastFrameAt);
    }),

  // Proxied helpers — Frigate-dependent.
  discover: adminProcedure
    .meta({ audit: false })
    .input(z.void())
    .output(z.array(z.object({ name: z.string(), live_src: z.string() })))
    .query(async () => {
      const found = await frigate.discoverCameras();
      return found.map((c) => ({ name: c.name, live_src: c.live_src }));
    }),

  /**
   * Validate that the proposed `live_src` name exists in go2rtc. Replaces the
   * old URL-probe behaviour now that cameras use go2rtc stream names instead of
   * raw RTSP URLs.
   */
  testStream: adminProcedure
    .meta({ audit: false })
    .input(z.object({ live_src: z.string().min(1) }))
    .output(z.object({ ok: z.boolean(), status: z.number().int().nullable() }))
    .mutation(async ({ input }) => {
      const result = await frigate.checkLiveSrc(input.live_src);
      return { ok: result.ok, status: null };
    }),

  /**
   * Grab one frame from the camera RTSP stream, crop to the configured band,
   * and return a base64 PNG of the cropped band plus the computed dark-pixel
   * ratio. Used by Settings → Cameras → Wheel Odometer to tune the band/threshold
   * visually before enabling the feature. Read-only — no state changes.
   */
  testWheelDetection: adminProcedure
    .meta({ audit: false })
    .input(z.object({ cameraId: z.number().int() }))
    .output(z.object({
      croppedPngBase64: z.string(),
      darkPixelRatio: z.number(),
      thresholdPct: z.number(),
      error: z.string().nullable(),
    }))
    .mutation(async ({ input }) => {
      const result = await testWheelDetection(input.cameraId);
      if ('error' in result) {
        return { croppedPngBase64: '', darkPixelRatio: 0, thresholdPct: 0, error: result.error };
      }
      return { ...result, error: null };
    }),

  /**
   * Sample the live RTSP feed for up to 30 s and return rotation-count,
   * distance, and a per-frame dark-pixel ratio trace. The operator runs this
   * after placing the tape mark to verify the odometer picks up real rotations
   * before enabling the persistent live session.
   *
   * Read-only — does not affect the persistent activeSessions map.
   */
  testWheelRotation: adminProcedure
    .meta({ audit: false })
    .input(z.object({
      cameraId: z.number().int(),
      durationS: z.number().int().min(5).max(30).optional(),
    }))
    .output(z.object({
      rotations: z.number(),
      sampledDurationS: z.number(),
      sampleFps: z.number(),
      framesSampled: z.number().int(),
      ratioTrace: z.array(z.number()),
      thresholdRatio: z.number(),
      distanceMeters: z.number(),
      diameterMm: z.number(),
    }))
    .mutation(async ({ input }) => {
      const { cameraId, durationS } = input;

      // Gate checks are inside liveWheelRotationTest; we translate its thrown
      // Errors into typed TRPCErrors the UI can display, and surface ffmpeg
      // stderr in the server log without leaking it to the client.
      try {
        return await liveWheelRotationTest(cameraId, durationS ?? 15);
      } catch (err) {
        if (err instanceof FfmpegError) {
          const log = childLogger('trpc.cameras');
          log.error(
            { cameraId, ffmpegCode: err.code, stderr: err.stderr },
            'testWheelRotation: ffmpeg failed',
          );
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `ffmpeg failed (exit ${err.code ?? 'signal'}): ${err.message}`,
          });
        }
        if (err instanceof Error) {
          // Eligibility / configuration errors — surface them as BAD_REQUEST so
          // the UI can show a user-readable reason without a stack trace.
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
        }
        throw err;
      }
    }),
});

// ---------------------------------------------------------------------------
// activity.*
// ---------------------------------------------------------------------------

const activityRouter = router({
  today: protectedProcedure
    .input(z.void())
    .output(z.array(diaryEntrySchema))
    .query(() => {
      const start = startOfLocalDay(new Date());
      const end = start + 24 * 60 * 60 * 1000;
      return db.listDiaryEntriesBetween(start, end).map(diaryToDTO);
    }),

  range: protectedProcedure
    .input(z.object({
      from: z.number().int().nonnegative(),
      to: z.number().int().positive(),
    }))
    .output(z.array(diaryEntrySchema))
    .query(({ input }) => {
      return db.listDiaryEntriesBetween(input.from, input.to).map(diaryToDTO);
    }),

  // Manual "Take a photo!" from the maximized view. Returns the diary entry
  // the frontend renders inline.
  snapshot: protectedProcedure
    .input(z.object({ camera_id: z.number().int() }))
    .output(diaryEntrySchema)
    .mutation(async ({ ctx, input }) => {
      const camera = db.getCameraById(input.camera_id);
      if (!camera) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'camera not found' });
      }
      const now = Date.now();
      // Frigate exposes a `latest.jpg` for any tracked camera; we cache that
      // image into STORAGE_PATH/snapshots/<camera>-<ts>.jpg. The file write is
      // best-effort: if Frigate isn't reachable we still record the diary
      // row with an empty media_path so the timestamp lands in the day's
      // feed.
      const snap = await frigate.captureLatestSnapshot(camera.live_src ?? camera.name, now);
      const entry = await saveManualSnapshot({
        cameraId: camera.id,
        takenAt: now,
        mediaPath: snap.path,
        userId: ctx.user.id,
      });
      return diaryToDTO(entry);
    }),

  // Admin-only debugging view: the in-memory ring buffer the narrator keeps
  // for tuning TRANSITION_WINDOW_MS / MIN_DWELL_MS.
  recentEvents: adminProcedure
    .meta({ audit: false })
    .input(z.void())
    .output(z.array(z.object({
      camera: z.string(),
      label: z.string(),
      zone: z.string().nullable(),
      type: z.enum(['new', 'update', 'end']),
      at: z.number().int(),
    })))
    .query(() => getRecentEvents()),

  /**
   * Delete a diary entry and its associated media file.
   *
   * Authorization:
   *   - Admin: may delete any entry of any kind.
   *   - Non-admin: may only delete snapshot entries they personally captured
   *     (entry.kind === 'snapshot' && entry.created_by === ctx.user.id).
   *
   * Side-effects:
   *   - Best-effort unlink of entry.media_path if set.
   *   - Hard delete of the linked snapshots row if entry.snapshot_id is set
   *     (the snapshot file is the same as media_path — unlinked once above).
   *   - Audit log row written for every deletion (admin or non-admin path).
   */
  delete: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const entry = db.getDiaryEntryById(input.id);
      if (!entry) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'diary entry not found' });
      }

      if (ctx.user.role !== 'admin') {
        if (entry.kind !== 'snapshot' || entry.created_by !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'you can only delete your own snapshots',
          });
        }
      }

      // Best-effort unlink — ENOENT is silently ignored.
      if (entry.media_path) {
        await deleteFileBestEffort(entry.media_path);
      }

      // Remove the snapshots table row. The file was already handled above.
      if (entry.snapshot_id !== null) {
        db.deleteSnapshot(entry.snapshot_id);
      }

      // Hard delete the diary row.
      db.deleteDiaryEntry(input.id);

      // Audit every deletion regardless of role — the audit middleware only
      // fires automatically for adminProcedure. We write explicitly here so
      // non-admin self-deletions are also tracked.
      db.insertAudit({
        actor_user_id: ctx.user.id,
        action: 'diary.delete',
        target_type: 'diary_entry',
        target_id: String(input.id),
        details: {
          kind: entry.kind,
          created_by: entry.created_by,
          was_admin: ctx.user.role === 'admin',
        },
      });

      return { ok: true } as const;
    }),
});

// ---------------------------------------------------------------------------
// stats.*
// ---------------------------------------------------------------------------

const statsZoneSchema = z.object({
  /** The narrator activity key (wheel, food, water, bathroom, resting, tunnel, hiding, exploring). */
  activity: diaryActivitySchema,
  count: z.number().int().nonnegative(),
  total_ms: z.number().int().nonnegative(),
});

const statsRouter = router({
  /**
   * Returns one tile per zone that the operator has wired up on any enabled
   * camera (union across cameras). If nothing is configured yet, falls back
   * to whatever activities the day's events show, so the scoreboard isn't
   * empty during initial onboarding before any zones have been pinned to a
   * camera in Settings → Cameras.
   */
  today: protectedProcedure
    .input(z.void())
    .output(z.object({
      zones: z.array(statsZoneSchema),
    }))
    .query(() => {
      const start = startOfLocalDay(new Date());
      const end = start + 24 * 60 * 60 * 1000;
      const entries = db.listDiaryEntriesBetween(start, end);

      // Union of configured zones across enabled cameras.
      const configured = new Set<db.DiaryActivity>();
      for (const cam of db.listCameras(false)) {
        for (const z of cam.zones) {
          if (isStatsActivity(z)) configured.add(z);
        }
      }

      // Onboarding fallback: with no configured zones, show whatever the day
      // produced so the operator sees something real before they configure.
      if (configured.size === 0) {
        for (const e of entries) {
          if (e.activity && isStatsActivity(e.activity)) configured.add(e.activity);
        }
      }

      const buckets = new Map<db.DiaryActivity, { count: number; total_ms: number }>();
      for (const e of entries) {
        if (!e.activity || !configured.has(e.activity)) continue;
        const cur = buckets.get(e.activity) ?? { count: 0, total_ms: 0 };
        cur.count += 1;
        cur.total_ms += e.duration_ms ?? 0;
        buckets.set(e.activity, cur);
      }

      // Stable ordering — alphabetical so tile positions don't shuffle.
      const zones = Array.from(configured)
        .sort()
        .map((activity) => ({
          activity,
          count: buckets.get(activity)?.count ?? 0,
          total_ms: buckets.get(activity)?.total_ms ?? 0,
        }));
      return { zones };
    }),

  wheelRecords: protectedProcedure
    .input(z.void())
    .output(z.object({
      /** Total wheel metres run today (local calendar day). */
      todayMeters: z.number(),
      /** Total wheel metres in the current 7-day window (Sun-origin local week). */
      weekMeters: z.number(),
      /** All-time cumulative wheel metres. */
      allTimeMeters: z.number(),
      /** Highest single-day wheel metres ever recorded (UTC day boundary). */
      bestDayMeters: z.number(),
      /** The UTC date string (YYYY-MM-DD) for the best day. Null when no data. */
      bestDayDate: z.string().nullable(),
      /** Highest single wheel-session metres ever recorded. */
      bestSessionMeters: z.number(),
      /** Per-day series for the last 14 days — sparse (days with 0 activity omitted). */
      dailySeries: z.array(z.object({
        date: z.string(),
        meters: z.number(),
      })),
      /** Total wheel time today in whole seconds (sum of wheel diary entry duration_ms). */
      todaySeconds: z.number().int(),
      /** Total wheel time this week in whole seconds. */
      weekSeconds: z.number().int(),
      /** All-time total wheel time in whole seconds. */
      allTimeSeconds: z.number().int(),
    }))
    .query(() => {
      const now = Date.now();
      const todayStart = startOfLocalDay(new Date(now));
      const todayEnd = todayStart + 24 * 60 * 60 * 1000;

      // Week: Sunday-based, same pattern as startOfLocalDay.
      const weekStart = startOfLocalWeek(new Date(now));

      const todayMeters = db.sumWheelMetersBetween(todayStart, todayEnd);
      const weekMeters = db.sumWheelMetersBetween(weekStart, now);
      const allTimeMeters = db.sumAllWheelMeters();

      // Wheel time in seconds (truncated, not rounded, to stay conservative).
      const todaySeconds = Math.trunc(db.sumWheelDurationMsBetween(todayStart, todayEnd) / 1000);
      const weekSeconds = Math.trunc(db.sumWheelDurationMsBetween(weekStart, now) / 1000);
      const allTimeSeconds = Math.trunc(db.sumAllWheelDurationMs() / 1000);

      // Daily series for the last 14 days.
      const fourteenDaysAgo = todayStart - 13 * 24 * 60 * 60 * 1000;
      const dailySeries = db.listWheelMetersByDay(fourteenDaysAgo);

      // Best day from the series — but we need all-time, so query all days.
      const allDays = db.listWheelMetersByDay(0);
      let bestDayMeters = 0;
      let bestDayDate: string | null = null;
      for (const day of allDays) {
        if (day.meters > bestDayMeters) {
          bestDayMeters = day.meters;
          bestDayDate = day.date;
        }
      }

      // Best single session: one diary_entries row with the highest wheel_meters.
      const bestSessionMeters = db.bestWheelSessionMeters();

      return {
        todayMeters,
        weekMeters,
        allTimeMeters,
        bestDayMeters,
        bestDayDate,
        bestSessionMeters,
        dailySeries,
        todaySeconds,
        weekSeconds,
        allTimeSeconds,
      };
    }),
});

/** Activities that make sense as a scoreboard tile (excludes snapshot/timelapse/transition). */
function isStatsActivity(value: string): value is db.DiaryActivity {
  return (
    value === 'wheel' ||
    value === 'food' ||
    value === 'water' ||
    value === 'bathroom' ||
    value === 'resting' ||
    value === 'tunnel' ||
    value === 'exploring' ||
    value === 'hiding'
  );
}

// ---------------------------------------------------------------------------
// pet.*
// ---------------------------------------------------------------------------

const activityValueSchema = z.enum([
  'wheel', 'food', 'water', 'bathroom', 'resting', 'tunnel', 'exploring', 'hiding',
]);

const petCurrentStatusSchema = z.object({
  /**
   * Classified activity derived from zone/camera name. Null when no in-memory
   * state exists (server just restarted or no Frigate events received yet).
   */
  activity: activityValueSchema.nullable(),
  /** Zone name from the most recent Frigate event. Null when no state. */
  zone: z.string().nullable(),
  /** Camera row id. Null when no state. */
  cameraId: z.number().int().nullable(),
  /** Milliseconds since the last sighting. Null when no state. */
  sinceMs: z.number().int().nonnegative().nullable(),
  /**
   * True when there is no state, or last sighting is older than 60 seconds
   * (Remy is probably napping somewhere off-camera).
   */
  stale: z.boolean(),
});
export type PetCurrentStatusDTO = z.infer<typeof petCurrentStatusSchema>;

const petRouter = router({
  currentStatus: protectedProcedure
    .input(z.void())
    .output(petCurrentStatusSchema)
    .query(() => {
      const status = getPetStatus();
      return {
        activity: status.activity,
        zone: status.zone,
        cameraId: status.cameraId,
        sinceMs: status.sinceMs !== null ? Math.round(status.sinceMs) : null,
        stale: status.stale,
      };
    }),
});

// ---------------------------------------------------------------------------
// badges.*
// ---------------------------------------------------------------------------

const badgesRouter = router({
  earned: protectedProcedure
    .input(z.void())
    .output(z.array(badgeSchema))
    .query(() => db.summarizeBadges()),
});

// ---------------------------------------------------------------------------
// users.*
// ---------------------------------------------------------------------------

const usersRouter = router({
  list: adminProcedure
    .meta({ audit: false })
    .input(z.void())
    .output(z.array(publicUserSchema))
    .query(() => db.listUsers().map((u) => db.toPublicUser(u))),

  create: adminProcedure
    .meta({
      audit: {
        action: 'users.create',
        targetType: 'user',
        // New user's id is the row we just inserted — only known post-mutation.
        targetIdFromResult: (result) =>
          isRecord(result) && typeof result['id'] === 'number' ? result['id'] : null,
        // Record the new user's email + display_name + role (NOT password, which
        // never reaches the audit table either way — it's not in the result).
        detailsFrom: (input) => {
          if (!isRecord(input)) return null;
          return {
            email: input['email'],
            display_name: input['display_name'],
            role: input['role'],
          };
        },
      },
    })
    .input(z.object({
      email: z.string().email(),
      display_name: z.string().min(1).max(40),
      password: z.string().min(6),
      role: roleSchema,
    }))
    .output(publicUserSchema)
    .mutation(async ({ ctx, input }) => {
      // Reactivation path: if a soft-deleted row exists for this email we can
      // re-attach to the existing Zyphr account without re-registering. The
      // admin-supplied password is intentionally ignored — the old Zyphr
      // password still applies; the admin can use Reset Password afterward.
      const deleted = db.getDeletedUserByEmail(input.email);
      if (deleted) {
        const row = db.reactivateUser({
          id: deleted.id,
          display_name: input.display_name,
          role: input.role,
          created_by: ctx.user.id,
        });
        return db.toPublicUser(row);
      }

      // Normal path: register at Zyphr first; only insert locally on 2xx.
      // Atomicity contract: Zyphr-register first; only insert the local row on
      // a 2xx upstream response. Atomicity contract is here at Stage 1 so the
      // Stage 2a implementation has nowhere to drift.
      let registered;
      try {
        registered = await registerAccount(input.email, input.password, input.display_name);
      } catch (err) {
        if (err instanceof ZyphrEmailTaken) {
          // True orphan: email exists at Zyphr but there is no local row (and
          // no soft-deleted row — we checked above). An operator must purge the
          // account in the Zyphr dashboard, or use a different email.
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'email is registered with the auth provider but has no local account; ' +
              'purge it in the Zyphr dashboard or use a different email',
          });
        }
        throw err;
      }
      const row = db.createUser({
        zyphr_user_id: registered.zyphr_user_id,
        email: input.email,
        display_name: input.display_name,
        role: input.role,
        created_by: ctx.user.id,
      });
      return db.toPublicUser(row);
    }),

  update: adminProcedure
    .meta({
      audit: {
        action: 'users.update',
        targetType: 'user',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        detailsFrom: (_input, result, ctx) => {
          const before = ctx.audit['before'];
          return diffObjects(
            isRecord(before) ? before : {},
            isRecord(result) ? result : {},
          );
        },
      },
    })
    .input(z.object({
      id: z.number().int(),
      display_name: z.string().min(1).max(40),
      role: roleSchema,
    }))
    .output(publicUserSchema)
    .mutation(({ ctx, input }) => {
      const target = db.getUserById(input.id);
      if (!target || target.deleted_at !== null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'user not found' });
      }
      // Refuse to demote the last remaining admin.
      if (target.role === 'admin' && input.role !== 'admin') {
        if (db.countAdmins() <= 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'cannot demote the last remaining admin',
          });
        }
      }
      // Snapshot the pre-update public projection for the audit diff.
      ctx.audit['before'] = db.toPublicUser(target);
      const row = db.updateUser(input);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'user not found' });
      // Defense-in-depth (Security-Review out-of-band recommendation): when
      // role changes, kill any active sessions for the affected user so a
      // promoted child / demoted admin doesn't keep the old in-memory role
      // until session expiry. requireAdmin re-checks role per-request via
      // db.getUserById, but rotation closes the window where an existing
      // session object's cached `user.role` would be stale.
      if (target.role !== row.role) {
        db.deleteSessionsForUser(row.id);
      }
      return db.toPublicUser(row);
    }),

  delete: adminProcedure
    .meta({
      audit: {
        action: 'users.delete',
        targetType: 'user',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        // Audit reviewer needs the deleted user's email/display_name — the
        // row itself is gone by the time they read the log.
        detailsFrom: (_input, _result, ctx) => {
          const before = ctx.audit['before'];
          if (!isRecord(before)) return null;
          return {
            email: before['email'],
            display_name: before['display_name'],
            role: before['role'],
          };
        },
      },
    })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      const target = db.getUserById(input.id);
      if (!target || target.deleted_at !== null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'user not found' });
      }
      if (target.role === 'admin' && db.countAdmins() <= 1) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'cannot delete the last remaining admin',
        });
      }
      if (target.id === ctx.user.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'cannot delete your own account from this UI; sign in as another admin first',
        });
      }
      ctx.audit['before'] = db.toPublicUser(target);
      db.deleteUser(input.id);
      return { ok: true } as const;
    }),

  resetPassword: adminProcedure
    .meta({
      audit: {
        action: 'users.resetPassword',
        targetType: 'user',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
      },
    })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ input }) => {
      const target = db.getUserById(input.id);
      if (!target || target.deleted_at !== null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'user not found' });
      }
      await triggerForgotPassword(target.email);
      return { ok: true } as const;
    }),

  changeOwnPassword: protectedProcedure
    .input(z.void())
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx }) => {
      await triggerForgotPassword(ctx.user.email);
      return { ok: true } as const;
    }),
});

// ---------------------------------------------------------------------------
// audit.*
// ---------------------------------------------------------------------------

const auditRouter = router({
  list: adminProcedure
    .meta({ audit: false })
    .input(z.object({
      cursor: z.number().int().nullable().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      actor_user_id: z.number().int().nullable().optional(),
      action_prefix: z.string().nullable().optional(),
      since: z.number().int().nullable().optional(),
      until: z.number().int().nullable().optional(),
    }))
    .output(z.object({
      items: z.array(auditLogSchema),
      next_cursor: z.number().int().nullable(),
    }))
    .query(({ input }) => {
      const items = db.listAudit({
        cursor: input.cursor ?? null,
        limit: input.limit,
        actor_user_id: input.actor_user_id ?? null,
        action_prefix: input.action_prefix ?? null,
        since: input.since ?? null,
        until: input.until ?? null,
      });
      const lastItem = items.length === input.limit ? items[items.length - 1] : null;
      const nextCursor = lastItem ? lastItem.id : null;
      return { items, next_cursor: nextCursor };
    }),
});

// ---------------------------------------------------------------------------
// recipients.*  (Send-a-Clip allowlist)
// ---------------------------------------------------------------------------

const recipientsRouter = router({
  list: protectedProcedure
    .input(z.void())
    .output(z.array(recipientSchema))
    .query(() => db.listShareRecipients()),

  create: adminProcedure
    .meta({
      audit: {
        action: 'recipients.create',
        targetType: 'recipient',
        targetIdFromResult: (result) =>
          isRecord(result) && typeof result['id'] === 'number' ? result['id'] : null,
        detailsFrom: (input) => {
          if (!isRecord(input)) return null;
          return { display_name: input['display_name'], email: input['email'] };
        },
      },
    })
    .input(z.object({
      display_name: z.string().min(1).max(40),
      email: z.string().email(),
    }))
    .output(recipientSchema)
    .mutation(({ ctx, input }) => db.createShareRecipient({
      display_name: input.display_name,
      email: input.email,
      added_by: ctx.user.id,
    })),

  update: adminProcedure
    .meta({
      audit: {
        action: 'recipients.update',
        targetType: 'recipient',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        detailsFrom: (_input, result, ctx) => {
          const before = ctx.audit['before'];
          return diffObjects(
            isRecord(before) ? before : {},
            isRecord(result) ? result : {},
          );
        },
      },
    })
    .input(z.object({
      id: z.number().int(),
      display_name: z.string().min(1).max(40),
      email: z.string().email(),
    }))
    .output(recipientSchema)
    .mutation(({ ctx, input }) => {
      const before = db.getShareRecipientById(input.id);
      if (before) ctx.audit['before'] = before;
      const row = db.updateShareRecipient(input);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'recipient not found' });
      return row;
    }),

  delete: adminProcedure
    .meta({
      audit: {
        action: 'recipients.delete',
        targetType: 'recipient',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        detailsFrom: (_input, _result, ctx) => {
          const before = ctx.audit['before'];
          if (!isRecord(before)) return null;
          return { display_name: before['display_name'], email: before['email'] };
        },
      },
    })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      const before = db.getShareRecipientById(input.id);
      if (before) ctx.audit['before'] = before;
      db.deleteShareRecipient(input.id);
      return { ok: true } as const;
    }),
});

// ---------------------------------------------------------------------------
// share.*
// ---------------------------------------------------------------------------

const shareRouter = router({
  send: protectedProcedure
    .input(z.object({
      diary_entry_id: z.number().int(),
      recipient_id: z.number().int(),
    }))
    .output(shareLogSchema)
    .mutation(async ({ ctx, input }) => {
      const row = await startShareJob({
        userId: ctx.user.id,
        recipientId: input.recipient_id,
        diaryEntryId: input.diary_entry_id,
      });
      return row;
    }),

  /** Live status of a previously-queued send. Polled by the frontend. */
  status: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .output(shareLogSchema.nullable())
    .query(({ ctx, input }) => {
      const row = db.getShareLogById(input.id);
      if (!row) return null;
      // A user can only see their own share-log entries; admins see all.
      if (ctx.user.role !== 'admin' && row.user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'forbidden' });
      }
      return row;
    }),

  listMine: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .output(z.array(shareLogSchema))
    .query(({ ctx, input }) => db.listShareLogForUser(ctx.user.id, input.limit)),
});

// ---------------------------------------------------------------------------
// admin.* — manual job triggers (Audit tab actions)
// ---------------------------------------------------------------------------

const adminRouter = router({
  rebuildTimelapse: adminProcedure
    .meta({
      audit: {
        action: 'admin.rebuildTimelapse',
        targetType: 'job',
        // Date string is the natural target — there's no row id for "the job".
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['date'] === 'string' ? input['date'] : null,
        detailsFrom: (_input, result) => (isRecord(result) ? result : null),
      },
    })
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .output(z.object({
      date: z.string(),
      produced: z.boolean(),
      media_path: z.string().nullable(),
      diary_entry_id: z.number().int().nullable(),
    }))
    .mutation(({ input }) => runTimelapseJob(new Date(`${input.date}T12:00:00`))),

  runRetention: adminProcedure
    .meta({
      audit: {
        action: 'admin.runRetention',
        targetType: 'job',
        detailsFrom: (_input, result) => (isRecord(result) ? result : null),
      },
    })
    .input(z.void())
    .output(z.object({
      snapshots_deleted: z.number().int().nonnegative(),
      timelapse_media_cleared: z.number().int().nonnegative(),
      audit_rows_deleted: z.number().int().nonnegative(),
      clips_deleted: z.number().int().nonnegative(),
      thumbnails_deleted: z.number().int().nonnegative(),
    }))
    .mutation(() => runRetentionJob()),

  runDiskWatch: adminProcedure
    .meta({
      audit: {
        action: 'admin.runDiskWatch',
        targetType: 'job',
        detailsFrom: (_input, result) => (isRecord(result) ? result : null),
      },
    })
    .input(z.void())
    .output(z.object({
      severity: z.enum(['ok', 'warn', 'critical']),
      pct_used: z.number(),
      free_gb: z.number(),
      alerted: z.boolean(),
    }))
    .mutation(() => runDiskWatchJob()),
});

// ---------------------------------------------------------------------------
// notifications.*
// ---------------------------------------------------------------------------

// Activities the user can subscribe to for push notifications — matches the
// set a narrator entry can have (excludes timelapse/recap/transition/snapshot
// which are never surfaced as push triggers).
const pushActivitySchema = z.enum([
  'wheel', 'food', 'water', 'bathroom', 'resting', 'tunnel', 'exploring', 'hiding',
]);

const notifPrefsSchema = z.object({
  enabled: z.boolean(),
  activities: z.array(pushActivitySchema),
  quiet_start_minute: z.number().int().min(0).max(1439),
  quiet_end_minute: z.number().int().min(0).max(1439),
  rare_only: z.boolean(),
});

function notifPrefsToDTO(row: db.NotificationPreferencesRow) {
  let activities: string[];
  try {
    const parsed = JSON.parse(row.activities) as unknown;
    activities = Array.isArray(parsed)
      ? parsed.filter((a): a is string => typeof a === 'string')
      : [];
  } catch {
    activities = [];
  }
  return {
    enabled: row.enabled === 1,
    activities: activities as z.infer<typeof pushActivitySchema>[],
    quiet_start_minute: row.quiet_start_minute,
    quiet_end_minute: row.quiet_end_minute,
    rare_only: row.rare_only === 1,
  };
}

const notifPreferencesRouter = router({
  get: protectedProcedure
    .input(z.void())
    .output(notifPrefsSchema)
    .query(({ ctx }) => notifPrefsToDTO(db.getNotificationPreferences(ctx.user.id))),

  set: protectedProcedure
    .input(notifPrefsSchema)
    .output(notifPrefsSchema)
    .mutation(({ ctx, input }) => {
      const row = db.upsertNotificationPreferences({
        user_id: ctx.user.id,
        enabled: input.enabled ? 1 : 0,
        activities: JSON.stringify(input.activities),
        quiet_start_minute: input.quiet_start_minute,
        quiet_end_minute: input.quiet_end_minute,
        rare_only: input.rare_only ? 1 : 0,
      });
      return notifPrefsToDTO(row);
    }),
});

const notificationsRouter = router({
  publicKey: protectedProcedure
    .input(z.void())
    .output(z.object({ vapidPublicKey: z.string().nullable() }))
    .query(() => ({ vapidPublicKey: getVapidPublicKey() })),

  subscribe: protectedProcedure
    .input(z.object({
      endpoint: z.string().url(),
      p256dh: z.string().min(1),
      auth: z.string().min(1),
      userAgent: z.string().optional(),
    }))
    .output(z.object({ id: z.number().int() }))
    .mutation(({ ctx, input }) => {
      const row = db.upsertPushSubscription({
        user_id: ctx.user.id,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        user_agent: input.userAgent ?? null,
      });
      return { id: row.id };
    }),

  unsubscribe: protectedProcedure
    .input(z.object({ endpoint: z.string().url() }))
    .output(z.object({ removed: z.number().int() }))
    .mutation(({ ctx, input }) => {
      const removed = db.deletePushSubscription(input.endpoint, ctx.user.id);
      return { removed };
    }),

  preferences: notifPreferencesRouter,

  test: protectedProcedure
    .input(z.void())
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx }) => {
      const petName = db.getSetting('pet_name') ?? 'Remy';
      await sendPushToUser(ctx.user.id, {
        title: `${petName} says hi!`,
        body: 'Test push from Remy 🐹',
        url: '/',
        tag: 'test',
      });
      return { ok: true } as const;
    }),
});

// ---------------------------------------------------------------------------
// clip.* — in-app video playback
// ---------------------------------------------------------------------------

const clipRouter = router({
  /**
   * Resolve (or extract + cache) a playable MP4 clip for a diary entry.
   *
   * Output:
   *   url        — browser-ready path for <video src>  (e.g. `/clips/cam1-123-133.mp4`)
   *   duration_ms — clip duration in ms (10 000 for extracted clips; null for timelapses)
   */
  get: protectedProcedure
    .input(z.object({ diary_entry_id: z.number().int() }))
    .output(z.object({
      url: z.string(),
      duration_ms: z.number().int().nullable(),
    }))
    .query(async ({ input }) => {
      const clipLog = childLogger('clip.get');
      const entry = db.getDiaryEntryById(input.diary_entry_id);
      if (!entry) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'diary entry not found' });
      }
      try {
        const { relPath } = await ensureClip(entry);
        return { url: `/${relPath}`, duration_ms: entry.duration_ms ?? null };
      } catch (err) {
        if (err instanceof TRPCError) throw err;

        // ffmpeg failure: footage may have aged out of Frigate's 3-day
        // continuous-recording retention, or the clip endpoint returned 404.
        // Log the stderr for diagnostics but surface a friendly message.
        if (err instanceof FfmpegError) {
          clipLog.warn(
            { diary_entry_id: input.diary_entry_id, ffmpegCode: err.code, stderr: err.stderr },
            'clip extraction failed — footage likely outside Frigate retention window',
          );
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: "This clip isn't available anymore.",
          });
        }

        const message = err instanceof Error ? err.message : 'clip extraction failed';
        // Entries with no camera_id and no mp4 media are structurally unable to
        // produce a clip — this is a client bug (button shown when clip_available
        // is false). Surface as 412 so the frontend can handle it gracefully.
        const isUnavailable =
          message.includes('no camera_id') || message.includes('cannot produce a clip');

        if (!isUnavailable) {
          clipLog.error(
            { diary_entry_id: input.diary_entry_id, err },
            'unexpected clip extraction error',
          );
        }

        throw new TRPCError({
          code: isUnavailable ? 'PRECONDITION_FAILED' : 'INTERNAL_SERVER_ERROR',
          message: isUnavailable
            ? 'No video is available for this diary entry.'
            : message,
        });
      }
    }),
});

// ---------------------------------------------------------------------------
// App router — frozen surface
// ---------------------------------------------------------------------------

export const appRouter = router({
  settings: settingsRouter,
  cameras: camerasRouter,
  activity: activityRouter,
  stats: statsRouter,
  pet: petRouter,
  badges: badgesRouter,
  users: usersRouter,
  audit: auditRouter,
  recipients: recipientsRouter,
  share: shareRouter,
  admin: adminRouter,
  notifications: notificationsRouter,
  clip: clipRouter,
});

export type AppRouter = typeof appRouter;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function startOfLocalDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

/** Start of the current week in local time (Sunday = 0). */
function startOfLocalWeek(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy.getTime();
}

/** Narrow `unknown` to a plain object so audit resolvers can read fields safely. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Shallow before/after diff for update-shape audit details. Returns
 *   { changed: { key: { before, after }, … } }
 * containing only the keys whose values differ (compared via JSON.stringify
 * so nested objects + arrays compare structurally). Keys present in one
 * object but not the other are also reported.
 *
 * The audit-log `details` column is meant for humans skimming a forensic
 * trail — concise is more valuable than exhaustive.
 */
function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { changed: Record<string, { before: unknown; after: unknown }> } {
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    // Structural compare via JSON; both sides are plain JSON-shaped already
    // (DTOs / settings KV / public users).
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed[k] = { before: a, after: b };
    }
  }
  return { changed };
}
